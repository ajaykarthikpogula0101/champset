import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import fp from "fastify-plugin";
import { createClerkClient, verifyToken, type ClerkClient } from "@clerk/backend";

import { env } from "./env.js";

/**
 * Clerk JWT verification for the Fastify backend.
 *
 * Design:
 *   - The backend is the agent runner. It primarily talks to Convex via the
 *     admin key for SYSTEM operations (see ./convex.ts).
 *   - Any HTTP endpoint that accepts a request *from a user* (frontend or
 *     external) MUST be gated by the `requireAuth` preHandler exported here.
 *     This verifies the bearer token against Clerk's JWKS and attaches the
 *     authenticated identity to the request.
 *   - Public endpoints (e.g. /health) skip the preHandler.
 *
 * Pattern for protected routes — see index.ts:
 *
 *   fastify.register(async (instance) => {
 *     instance.addHook("preHandler", requireAuth);
 *     instance.get("/me", async (req) => req.auth);
 *   });
 *
 * NEVER trust user-supplied `userId` in request bodies. Use req.auth.userId.
 */

declare module "fastify" {
  interface FastifyRequest {
    auth?: { userId: string };
  }
  interface FastifyInstance {
    clerk: ClerkClient;
  }
}

const clerkPlugin: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  if (!env.CLERK_SECRET_KEY) {
    fastify.log.warn(
      "CLERK_SECRET_KEY not set — protected routes will reject all requests. " +
        "Set it before adding routes that require auth.",
    );
  }

  const clerk = createClerkClient({
    secretKey: env.CLERK_SECRET_KEY ?? "",
    publishableKey: env.CLERK_PUBLISHABLE_KEY ?? "",
  });
  fastify.decorate("clerk", clerk);
};

/**
 * Resolve a user's primary email address by Clerk user id.
 *
 * Returns `null` if the user has no primary email (phone-only auth, rare
 * config) or if Clerk's API errors. Callers should treat `null` as
 * "skip the email" — never throw, since email is always best-effort.
 */
export async function getUserEmail(
  clerk: ClerkClient,
  userId: string,
): Promise<string | null> {
  try {
    const user = await clerk.users.getUser(userId);
    return user.primaryEmailAddress?.emailAddress ?? null;
  } catch {
    return null;
  }
}

export default fp(clerkPlugin, { name: "clerk-auth" });

/**
 * Fastify preHandler that requires a valid Clerk session token.
 *
 * Reads `Authorization: Bearer <token>`, verifies it via Clerk's
 * `verifyToken` (networkless JWT verification against the instance JWKS),
 * and attaches `req.auth = { userId }` on success. Returns 401 otherwise.
 */
export async function requireAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!env.CLERK_SECRET_KEY) {
    req.log.error("CLERK_SECRET_KEY is not set; cannot verify request");
    await reply.code(500).send({ error: "Auth not configured" });
    return;
  }

  // Verify the bearer token directly. `verifyToken` is the correct primitive
  // for API token verification (networkless JWT verify against the instance's
  // JWKS). We deliberately do NOT use `authenticateRequest` here — it is built
  // for cookie/handshake flows and, given a bare Bearer token, retries for
  // ~5s and returns `unexpected-error` instead of verifying the token.
  const authz = req.headers["authorization"];
  const header = Array.isArray(authz) ? authz[0] : authz;
  const raw =
    header && header.startsWith("Bearer ") ? header.slice(7).trim() : "";

  if (!raw) {
    await reply.code(401).send({ error: "Unauthenticated" });
    return;
  }

  try {
    const payload = await verifyToken(raw, {
      secretKey: env.CLERK_SECRET_KEY,
      // Token must be issued for our frontend origin. Clerk session tokens
      // minted in the browser carry azp = the page origin; tokens without an
      // azp claim (e.g. server-minted) pass this check.
      authorizedParties: [env.CLIENT_ORIGIN],
    });

    if (!payload.sub) {
      await reply.code(401).send({ error: "Unauthenticated" });
      return;
    }

    req.auth = { userId: payload.sub };
    return;
  } catch (err) {
    req.log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "[requireAuth] token verification failed",
    );
    await reply.code(401).send({ error: "Unauthenticated" });
    return;
  }
}
