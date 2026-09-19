import {
  query,
  mutation,
  internalMutation,
  internalQuery,
} from "./_generated/server.js";
import { v } from "convex/values";
import { loadOwnedDataset, loadReadableDataset } from "./lib/authz.js";

const urlValidator = v.string();
const MAX_PAGES_LIMIT = 500;

function assertValidUrl(raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("URL must use http or https protocol");
  }
}

function assertValidMaxPages(maxPages: number): void {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES_LIMIT) {
    throw new Error(`max_pages must be between 1 and ${MAX_PAGES_LIMIT}`);
  }
}

/**
 * List all blog scrape sources for a dataset. Caller must be the owner or the
 * dataset must be public.
 */
export const listByDataset = query({
  args: { datasetId: v.id("datasets") },
  handler: async (ctx, args) => {
    await loadReadableDataset(ctx, args.datasetId);
    return await ctx.db
      .query("scrapeSources")
      .withIndex("by_dataset", (q) => q.eq("datasetId", args.datasetId))
      .collect();
  },
});

/**
 * Fetch a single source. Caller must be able to read the parent dataset.
 */
export const get = query({
  args: { id: v.id("scrapeSources") },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.id);
    if (!source) throw new Error("Scrape source not found");
    await loadReadableDataset(ctx, source.datasetId);
    return source;
  },
});

/**
 * Internal query for the backend's admin-key calls. Returns all enabled
 * sources for a dataset using the compound index.
 */
export const listEnabledInternal = internalQuery({
  args: { datasetId: v.id("datasets") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("scrapeSources")
      .withIndex("by_dataset_enabled", (q) =>
        q.eq("datasetId", args.datasetId).eq("enabled", true),
      )
      .collect();
  },
});

/**
 * Insert a new blog source. Caller must be the owner of the parent dataset.
 */
export const insert = mutation({
  args: {
    datasetId: v.id("datasets"),
    url: urlValidator,
    source_name: v.string(),
    max_pages: v.optional(v.number()),
    field_map: v.optional(v.record(v.string(), v.string())),
    constants: v.optional(v.record(v.string(), v.string())),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    await loadOwnedDataset(ctx, args.datasetId);
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    assertValidUrl(args.url);
    if (args.max_pages !== undefined) assertValidMaxPages(args.max_pages);

    return await ctx.db.insert("scrapeSources", {
      datasetId: args.datasetId,
      url: args.url.trim(),
      source_name: args.source_name.trim(),
      max_pages: args.max_pages,
      field_map: args.field_map,
      constants: args.constants,
      enabled: args.enabled,
      added_by: identity.subject,
      added_at: Date.now(),
    });
  },
});

/**
 * Update an existing blog source. Caller must be the owner of the parent dataset.
 */
export const update = mutation({
  args: {
    id: v.id("scrapeSources"),
    url: v.optional(urlValidator),
    source_name: v.optional(v.string()),
    max_pages: v.optional(v.number()),
    field_map: v.optional(v.record(v.string(), v.string())),
    constants: v.optional(v.record(v.string(), v.string())),
    enabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.id);
    if (!source) throw new Error("Scrape source not found");

    await loadOwnedDataset(ctx, source.datasetId);

    if (args.url !== undefined) assertValidUrl(args.url);
    if (args.max_pages !== undefined) assertValidMaxPages(args.max_pages);

    const patch: Record<string, unknown> = {};
    if (args.url !== undefined) patch.url = args.url.trim();
    if (args.source_name !== undefined) patch.source_name = args.source_name.trim();
    if (args.max_pages !== undefined) patch.max_pages = args.max_pages;
    if (args.field_map !== undefined) patch.field_map = args.field_map;
    if (args.constants !== undefined) patch.constants = args.constants;
    if (args.enabled !== undefined) patch.enabled = args.enabled;

    await ctx.db.patch(args.id, patch);
  },
});

/**
 * Remove a blog source. Caller must be the owner of the parent dataset.
 */
export const remove = mutation({
  args: { id: v.id("scrapeSources") },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.id);
    if (!source) throw new Error("Scrape source not found");

    await loadOwnedDataset(ctx, source.datasetId);

    await ctx.db.delete(args.id);
  },
});

/**
 * Toggle the enabled state of a blog source. Caller must be the owner.
 */
export const toggle = mutation({
  args: { id: v.id("scrapeSources") },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.id);
    if (!source) throw new Error("Scrape source not found");

    await loadOwnedDataset(ctx, source.datasetId);

    await ctx.db.patch(args.id, { enabled: !source.enabled });
  },
});

/**
 * Record telemetry for a scrape run. Internal mutation — called by the backend
 * when a run starts, and again when it finishes.
 */
export const recordRun = internalMutation({
  args: {
    id: v.id("scrapeSources"),
    status: v.union(
      v.literal("running"),
      v.literal("success"),
      v.literal("error"),
    ),
    jobId: v.optional(v.string()),
    error: v.optional(v.string()),
    rowsWritten: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.id);
    if (!source) throw new Error("Scrape source not found");

    await ctx.db.patch(args.id, {
      lastJobId: args.jobId ?? source.lastJobId,
      lastRunAt: Date.now(),
      lastRunStatus: args.status,
      lastRunError: args.error,
      lastRunRowsWritten: args.rowsWritten,
    });
  },
});
