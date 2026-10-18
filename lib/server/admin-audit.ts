import "server-only";
import { ObjectId, type ClientSession, type Filter } from "mongodb";
import {
  ADMIN_PAGE_SIZE,
  isAdminAction,
  isAuditTargetType,
  type AdminAction,
  type AuditEntry,
  type AuditPage,
  type AuditTargetType,
} from "@/lib/admin/types";
import { getDb } from "./db";
import { HttpError } from "./http";
import { COLLECTIONS, type AdminAuditDoc, type UserDoc } from "./models";

// The admin audit trail. Records are only ever inserted, inside the same
// transaction as the change they describe (pass that transaction's session),
// so a change can't commit without its record or the other way round. There
// is deliberately no update or delete here, and no route that offers one.

export type AuditInput = {
  actorUserId: ObjectId | null;
  action: AdminAction;
  target: { type: AuditTargetType; id: string };
  reason?: string | null;
  from?: string | null;
  to?: string | null;
};

const auditCollection = async () => (await getDb()).collection<AdminAuditDoc>(COLLECTIONS.adminAudit);

/** Appends one record in `session`'s transaction. Returns it as stored. */
export async function recordAudit(input: AuditInput, session: ClientSession, at = new Date()): Promise<AdminAuditDoc> {
  if (!isAdminAction(input.action) || !isAuditTargetType(input.target.type))
    throw new Error("Invalid audit record.");
  const doc: AdminAuditDoc = {
    _id: new ObjectId(),
    actorUserId: input.actorUserId,
    action: input.action,
    target: { type: input.target.type, id: input.target.id },
    reason: input.reason ?? null,
    from: input.from ?? null,
    to: input.to ?? null,
    at,
  };
  await (await auditCollection()).insertOne(doc, { session });
  return doc;
}

export type AuditFilters = {
  action: AdminAction | null;
  targetType: AuditTargetType | null;
  targetId: string | null;
  actorUserId: ObjectId | null;
};

const TARGET_ID = /^(?:[0-9a-f]{24}|FKO-[A-Z0-9]{8})$/;

/** Reads filters from a query string; anything unrecognised is a 400, never ignored silently. */
export function parseAuditFilters(params: URLSearchParams): AuditFilters {
  const action = params.get("action") || null;
  const targetType = params.get("targetType") || null;
  const targetId = params.get("targetId")?.trim() || null;
  const actor = params.get("actor")?.trim().toLowerCase() || null;
  const fieldErrors: Record<string, string> = {};
  if (action !== null && !isAdminAction(action)) fieldErrors.action = "Unknown action.";
  if (targetType !== null && !isAuditTargetType(targetType)) fieldErrors.targetType = "Unknown target type.";
  if (targetId !== null && !TARGET_ID.test(targetId)) fieldErrors.targetId = "Enter a user, review or course id, or an order number.";
  if (actor !== null && !/^[0-9a-f]{24}$/.test(actor)) fieldErrors.actor = "Enter an admin's user id.";
  if (Object.keys(fieldErrors).length) throw new HttpError(400, "Please correct the filters.", fieldErrors);
  return {
    action: action as AdminAction | null,
    targetType: targetType as AuditTargetType | null,
    targetId,
    actorUserId: actor ? new ObjectId(actor) : null,
  };
}

/** Display names for the admins named in some audit records (names only). */
async function actorNames(docs: AdminAuditDoc[]): Promise<Map<string, string>> {
  const ids = [...new Set(docs.flatMap((d) => (d.actorUserId ? [d.actorUserId.toHexString()] : [])))].map(
    (id) => new ObjectId(id),
  );
  if (!ids.length) return new Map();
  const users = await (await getDb())
    .collection<UserDoc>(COLLECTIONS.users)
    .find({ _id: { $in: ids } }, { projection: { fullName: 1 } })
    .toArray();
  return new Map(users.map((u) => [u._id.toHexString(), u.fullName]));
}

export function toAuditEntry(doc: AdminAuditDoc, names: Map<string, string>): AuditEntry {
  const actor = doc.actorUserId?.toHexString() ?? null;
  return {
    id: doc._id.toHexString(),
    action: doc.action,
    actorUserId: actor,
    actorName: actor ? (names.get(actor) ?? null) : null,
    target: { type: doc.target.type, id: doc.target.id },
    reason: doc.reason,
    from: doc.from,
    to: doc.to,
    at: doc.at.toISOString(),
  };
}

/** A page of the trail, newest first. */
export async function listAudit(filters: AuditFilters, page: number, pageSize = ADMIN_PAGE_SIZE): Promise<AuditPage> {
  const query: Filter<AdminAuditDoc> = {};
  if (filters.action) query.action = filters.action;
  if (filters.targetType) query["target.type"] = filters.targetType;
  if (filters.targetId) query["target.id"] = filters.targetId;
  if (filters.actorUserId) query.actorUserId = filters.actorUserId;
  const docs = await (await auditCollection())
    .find(query)
    .sort({ at: -1, _id: -1 })
    .skip((page - 1) * pageSize)
    .limit(pageSize + 1)
    .toArray();
  const shown = docs.slice(0, pageSize);
  const names = await actorNames(shown);
  return { entries: shown.map((doc) => toAuditEntry(doc, names)), page, hasMore: docs.length > pageSize };
}

/** Every record about one target, newest first (bounded), for a case's history. */
export async function auditFor(type: AuditTargetType, id: string, limit = 50): Promise<AuditEntry[]> {
  const docs = await (await auditCollection())
    .find({ "target.type": type, "target.id": id })
    .sort({ at: -1, _id: -1 })
    .limit(limit)
    .toArray();
  const names = await actorNames(docs);
  return docs.map((doc) => toAuditEntry(doc, names));
}
