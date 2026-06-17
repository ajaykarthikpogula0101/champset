import { query, mutation, internalQuery, internalMutation } from "./_generated/server.js";
import { v } from "convex/values";
import { getIdentity } from "./lib/authz.js";

export const get = query({
  args: {},
  handler: async (ctx) => {
    const identity = await getIdentity(ctx);
    if (!identity) return null;

    const existing = await ctx.db
      .query("modelConfig")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .first();
    return existing ?? null;
  },
});

/**
 * Set the authenticated user's web engine (the Variation A/B toggle).
 *
 * This is the ONLY model-config field a regular user may write directly, and
 * it is per-user by design so every tester can choose which variation to build.
 * Model slugs are deliberately NOT writable here: which models the app runs is
 * an app-wide setting controlled by an admin through the backend
 * (POST /settings/models, gated by ADMIN_USER_IDS), which writes the shared
 * global config via an internal mutation. Keeping slugs out of this public
 * mutation closes the bypass where a non-admin could set models straight
 * through Convex.
 */
export const upsert = mutation({
  args: {
    searchProvider: v.union(v.literal("searxng"), v.literal("exa")),
  },
  handler: async (ctx, args) => {
    const identity = await getIdentity(ctx);
    if (!identity) throw new Error("Not authenticated");

    const existing = await ctx.db
      .query("modelConfig")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, { searchProvider: args.searchProvider });
    } else {
      await ctx.db.insert("modelConfig", {
        userId: identity.subject,
        searchProvider: args.searchProvider,
      });
    }
  },
});

export const getInternal = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("modelConfig")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();
    return existing ?? null;
  },
});

/**
 * Upsert model preferences for a specific user (internal, backend-only).
 *
 * Only fields that are explicitly provided (not undefined) are updated.
 * Unset fields are omitted from the insert, leaving the database unchanged.
 */
export const upsertInternal = internalMutation({
  args: {
    userId: v.string(),
    schemaInference: v.optional(v.string()),
    populateOrchestrator: v.optional(v.string()),
    investigateSubagent: v.optional(v.string()),
    searchProvider: v.optional(v.union(v.literal("searxng"), v.literal("exa"))),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("modelConfig")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();

    const patch: Record<string, string | null> = {};
    if (args.schemaInference !== undefined) patch.schemaInference = args.schemaInference;
    if (args.populateOrchestrator !== undefined) patch.populateOrchestrator = args.populateOrchestrator;
    if (args.investigateSubagent !== undefined) patch.investigateSubagent = args.investigateSubagent;
    if (args.searchProvider !== undefined) patch.searchProvider = args.searchProvider;

    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("modelConfig", {
        userId: args.userId,
        ...patch,
      });
    }
  },
});
