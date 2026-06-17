import { env } from "./env.js";

/**
 * Admin authorization check.
 *
 * The ONLY source of truth for admin status is the ADMIN_USER_IDS env
 * allowlist (a list of Clerk user ids). This helper reads that allowlist and
 * the trusted `req.auth.userId` set by `requireAuth` (see ./clerk-auth.ts) from
 * a verified Clerk JWT. It must NEVER be passed a user id taken from a request
 * body or query string, which the client controls.
 *
 * Admin is required to edit the app-wide model configuration and to refresh the
 * shared OpenRouter model catalog. Everything else is open to any authenticated
 * user. The frontend may receive an `isAdmin` flag for convenience (to hide
 * controls), but that flag is cosmetic. The backend 403 is the real boundary.
 */
export function isAdmin(userId: string | null | undefined): boolean {
  return !!userId && env.ADMIN_USER_IDS.includes(userId);
}
