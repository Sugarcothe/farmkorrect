import "server-only";
import { ObjectId, type Filter } from "mongodb";
import {
  ADMIN_PAGE_SIZE,
  type AuditEntry,
  type CredentialCase,
  type CredentialDecision,
  type CredentialPage,
} from "@/lib/admin/types";
import { validateAdminReason } from "@/lib/admin/validation";
import { cleanText } from "@/lib/profile/validation";
import { auditFor, recordAudit } from "./admin-audit";
import { getDb } from "./db";
import { HttpError } from "./http";
import { COLLECTIONS, type UserDoc } from "./models";
import { queueNotifications, syncCredentialNotification } from "./notifications";
import { inTransaction } from "./order-store";

// Credential review: an admin approves or rejects the registration details a
// veterinarian or specialist submitted in their profile. Approval means the
// Farm Korret team reviewed what was submitted; the app doesn't check any
// external licensing register. Only a "pending" submission can be decided,
// and only the exact submission the admin looked at.

const PROFESSIONAL_ROLES = ["veterinarian", "non-vet-specialist"] as const;

const NOT_FOUND = "We couldn't find that credential.";

async function users() {
  return (await getDb()).collection<UserDoc>(COLLECTIONS.users);
}

const PROJECTION = { fullName: 1, role: 1, profile: 1 } as const;

function toCase(user: UserDoc): CredentialCase {
  const p = user.profile ?? {};
  return {
    userId: user._id.toHexString(),
    fullName: user.fullName,
    role: user.role as CredentialCase["role"],
    registrationNumber: p.registrationNumber ?? "",
    specialization: p.specialization ?? "",
    qualifications: p.qualifications ?? "",
    location: p.location ?? "",
    status: p.credentialStatus ?? "not_submitted",
    submittedAt: p.credentialSubmittedAt?.toISOString() ?? null,
    reviewedAt: p.credentialReviewedAt?.toISOString() ?? null,
  };
}

/** Submissions waiting for a decision, oldest first. */
export async function listPendingCredentials(page: number, pageSize = ADMIN_PAGE_SIZE): Promise<CredentialPage> {
  const docs = await (await users())
    .find(
      { role: { $in: [...PROFESSIONAL_ROLES] }, "profile.credentialStatus": "pending" },
      { projection: PROJECTION },
    )
    .sort({ "profile.credentialSubmittedAt": 1, _id: 1 })
    .skip((page - 1) * pageSize)
    .limit(pageSize + 1)
    .toArray();
  return { cases: docs.slice(0, pageSize).map(toCase), page, hasMore: docs.length > pageSize };
}

export async function countPendingCredentials(): Promise<number> {
  return (await users()).countDocuments({ role: { $in: [...PROFESSIONAL_ROLES] }, "profile.credentialStatus": "pending" });
}

/** One professional's credential and its decision history, or null. */
export async function getCredentialCase(id: string): Promise<{ case: CredentialCase; history: AuditEntry[] } | null> {
  if (!ObjectId.isValid(id) || !/^[0-9a-f]{24}$/i.test(id)) return null;
  const user = await (await users()).findOne(
    { _id: new ObjectId(id), role: { $in: [...PROFESSIONAL_ROLES] } },
    { projection: PROJECTION },
  );
  if (!user) return null;
  return { case: toCase(user), history: await auditFor("user", user._id.toHexString()) };
}

export type ParsedCredentialDecision = { decision: CredentialDecision; reason: string | null; submittedAt: Date };

export function parseCredentialDecision(body: Record<string, unknown>): ParsedCredentialDecision {
  const fieldErrors: Record<string, string> = {};
  const unknown = Object.keys(body).filter((k) => !["decision", "reason", "submittedAt"].includes(k));
  if (unknown.length) fieldErrors[unknown[0]] = "This field can't be sent.";
  const decision = body.decision;
  if (decision !== "approve" && decision !== "reject") fieldErrors.decision = "Choose approve or reject.";
  const rawReason = body.reason;
  if (rawReason !== undefined && typeof rawReason !== "string") fieldErrors.reason = "Give a reason.";
  const reason = typeof rawReason === "string" ? cleanText(rawReason, true) : "";
  if (decision === "reject" || reason) {
    const error = validateAdminReason(reason);
    if (error) fieldErrors.reason = error;
  }
  const submittedAt = typeof body.submittedAt === "string" ? new Date(body.submittedAt) : null;
  if (!submittedAt || Number.isNaN(submittedAt.getTime())) fieldErrors.submittedAt = "Reload the page and try again.";
  if (Object.keys(fieldErrors).length) throw new HttpError(400, "Please correct the highlighted fields.", fieldErrors);
  return { decision: decision as CredentialDecision, reason: reason || null, submittedAt: submittedAt! };
}

/**
 * Approves or rejects a pending submission. The status change and its audit
 * record commit together; the change only applies while the submission is
 * still pending and unchanged, so a stale or repeated decision is refused.
 */
export async function decideCredential(
  admin: UserDoc,
  id: string,
  input: ParsedCredentialDecision,
): Promise<CredentialCase> {
  if (!/^[0-9a-f]{24}$/i.test(id)) throw new HttpError(404, NOT_FOUND);
  const userId = new ObjectId(id);
  if (userId.equals(admin._id)) throw new HttpError(403, "You can't review your own credentials.");
  const collection = await users();
  const current = await collection.findOne({ _id: userId, role: { $in: [...PROFESSIONAL_ROLES] } }, { projection: PROJECTION });
  if (!current) throw new HttpError(404, NOT_FOUND);
  const status = current.profile?.credentialStatus ?? "not_submitted";
  if (status === "not_submitted" || !current.profile?.registrationNumber)
    throw new HttpError(409, "Nothing has been submitted for review.");
  if (status !== "pending") throw new HttpError(409, "This credential has already been decided.");

  const to = input.decision === "approve" ? "verified" : "rejected";
  const updated = await inTransaction(async (session) => {
    const now = new Date();
    const filter: Filter<UserDoc> = {
      _id: userId,
      role: { $in: [...PROFESSIONAL_ROLES] },
      status: "active",
      "profile.credentialStatus": "pending",
      "profile.credentialSubmittedAt": input.submittedAt,
      "profile.registrationNumber": { $type: "string", $ne: "" },
    };
    const user = await collection.findOneAndUpdate(
      filter,
      {
        $set: {
          "profile.credentialStatus": to,
          "profile.credentialReviewedAt": now,
          notifySyncAt: now,
          updatedAt: now,
        },
      },
      { returnDocument: "after", projection: PROJECTION, session },
    );
    if (!user) return null;
    await recordAudit(
      {
        actorUserId: admin._id,
        action: input.decision === "approve" ? "credential.approve" : "credential.reject",
        target: { type: "user", id },
        reason: input.reason,
        from: "pending",
        to,
      },
      session,
      now,
    );
    return user;
  });
  if (!updated)
    throw new HttpError(409, "This submission changed or was already decided. Reload to see the latest details.");
  await queueNotifications("credential notification", () => syncCredentialNotification(userId));
  return toCase(updated);
}
