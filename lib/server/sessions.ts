import "server-only";
import { ObjectId, type ClientSession } from "mongodb";
import { getAuthConfig } from "./config";
import { hashToken, randomToken } from "./crypto";
import { getDb } from "./db";
import { HttpError, readCookie } from "./http";
import { COLLECTIONS, type SessionDoc, type SessionKind, type UserDoc } from "./models";

// Opaque, database-backed sessions. The browser holds a random 256-bit token
// in an httpOnly cookie; MongoDB holds only its SHA-256, so a database leak
// doesn't hand out live sessions.

export const SESSION_TTL_MS: Record<SessionKind, number> = {
  full: 30 * 24 * 60 * 60_000,
  pending: 60 * 60_000,
};

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type IssuedSession = { token: string; expiresAt: Date; maxAgeSeconds: number };

export async function createSession(
  userId: ObjectId,
  kind: SessionKind,
  dbSession?: ClientSession,
  now = new Date(),
): Promise<IssuedSession> {
  const token = randomToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS[kind]);
  await (await getDb()).collection<SessionDoc>(COLLECTIONS.sessions).insertOne(
    {
      _id: new ObjectId(),
      userId,
      kind,
      tokenHash: hashToken(token),
      createdAt: now,
      expiresAt,
      revokedAt: null,
    },
    { session: dbSession },
  );
  return { token, expiresAt, maxAgeSeconds: Math.floor(SESSION_TTL_MS[kind] / 1000) };
}

export type ActiveSession = { session: SessionDoc; user: UserDoc };

/** The live session and its user for a cookie value, or null. */
export async function findSession(
  token: string | null | undefined,
  now = new Date(),
): Promise<ActiveSession | null> {
  if (!token || !TOKEN_PATTERN.test(token)) return null;
  const db = await getDb();
  const session = await db.collection<SessionDoc>(COLLECTIONS.sessions).findOne({
    tokenHash: hashToken(token),
    revokedAt: null,
    expiresAt: { $gt: now },
  });
  if (!session) return null;
  const user = await db.collection<UserDoc>(COLLECTIONS.users).findOne({ _id: session.userId });
  return user ? { session, user } : null;
}

/** For route handlers: the session named by the request's cookie, if live. */
export function getRequestSession(request: Request): Promise<ActiveSession | null> {
  return findSession(readSessionToken(request));
}

export function readSessionToken(request: Request): string | null {
  return readCookie(request, getAuthConfig().cookieName);
}

/** A full session for a verified, active account — the bar for private data. */
export function isFullyAuthenticated(active: ActiveSession | null): active is ActiveSession {
  return (
    !!active &&
    active.session.kind === "full" &&
    active.user.status === "active" &&
    active.user.phoneVerifiedAt !== null
  );
}

export async function revokeSessionToken(token: string | null | undefined, dbSession?: ClientSession) {
  if (!token || !TOKEN_PATTERN.test(token)) return;
  await (await getDb())
    .collection<SessionDoc>(COLLECTIONS.sessions)
    .updateOne(
      { tokenHash: hashToken(token), revokedAt: null },
      { $set: { revokedAt: new Date() } },
      { session: dbSession },
    );
}

export async function revokeUserSessions(userId: ObjectId, dbSession?: ClientSession) {
  await (await getDb())
    .collection<SessionDoc>(COLLECTIONS.sessions)
    .updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } }, { session: dbSession });
}

/**
 * For route handlers acting on the caller's own account: the verified,
 * signed-in session, or a 401/403.
 */
export async function requireVerifiedRequest(request: Request, unverifiedMessage: string): Promise<ActiveSession> {
  const active = await getRequestSession(request);
  if (!active) throw new HttpError(401, "Your session has ended. Please log in again.");
  if (!isFullyAuthenticated(active)) throw new HttpError(403, unverifiedMessage);
  return active;
}
