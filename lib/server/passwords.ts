import "server-only";
import argon2 from "argon2";

// Argon2id with the OWASP-recommended baseline (19 MiB, 2 passes, 1 lane).
const OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Upper bound so a huge password can't be used to tie up the hasher. */
export const MAX_PASSWORD_LENGTH = 128;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Runs a full verification against a throwaway hash, so a login for an
 * unknown account takes as long as one for a real account.
 */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword("farm-korret-timing-equaliser");
  await verifyPassword(await dummyHash, password);
}
