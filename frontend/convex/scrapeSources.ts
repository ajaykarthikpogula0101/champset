import {
  query,
  mutation,
  internalMutation,
  internalQuery,
} from "./_generated/server.js";
import { v } from "convex/values";
import { loadOwnedDataset, loadReadableDataset } from "./lib/authz.js";

const modeValidator = v.union(
  v.literal("css"),
  v.literal("ai"),
  v.literal("auto"),
  v.literal("prompt"),
);

const urlValidator = v.string();

/**
 * List all scrape sources for a dataset. Caller must be the owner or the
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
 * Insert a new scrape source. Caller must be the owner of the parent dataset.
 */
export const insert = mutation({
  args: {
    datasetId: v.id("datasets"),
    url: urlValidator,
    source_name: v.string(),
    extraction_schema: v.optional(v.any()),
    extraction_prompt: v.optional(v.string()),
    mode: v.optional(modeValidator),
    field_map: v.optional(v.record(v.string(), v.string())),
    constants: v.optional(v.record(v.string(), v.string())),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const dataset = await loadOwnedDataset(ctx, args.datasetId);
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    // Validate URL
    let parsed: URL;
    try {
      parsed = new URL(args.url);
    } catch {
      throw new Error("Invalid URL");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("URL must use http or https protocol");
    }

    // Require either extraction_schema or extraction_prompt
    if (!args.extraction_schema && !args.extraction_prompt) {
      throw new Error(
        "Either extraction_schema or extraction_prompt must be provided",
      );
    }

    return await ctx.db.insert("scrapeSources", {
      datasetId: args.datasetId,
      url: args.url.trim(),
      source_name: args.source_name.trim(),
      extraction_schema: args.extraction_schema,
      extraction_prompt: args.extraction_prompt,
      mode: args.mode,
      field_map: args.field_map,
      constants: args.constants,
      enabled: args.enabled,
      added_by: identity.subject,
      added_at: Date.now(),
    });
  },
});

/**
 * Update an existing scrape source. Caller must be the owner of the parent dataset.
 */
export const update = mutation({
  args: {
    id: v.id("scrapeSources"),
    url: v.optional(urlValidator),
    source_name: v.optional(v.string()),
    extraction_schema: v.optional(v.any()),
    extraction_prompt: v.optional(v.string()),
    mode: v.optional(modeValidator),
    field_map: v.optional(v.record(v.string(), v.string())),
    constants: v.optional(v.record(v.string(), v.string())),
    enabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.id);
    if (!source) throw new Error("Scrape source not found");

    await loadOwnedDataset(ctx, source.datasetId);

    // Validate URL if provided
    if (args.url !== undefined) {
      let parsed: URL;
      try {
        parsed = new URL(args.url);
      } catch {
        throw new Error("Invalid URL");
      }
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("URL must use http or https protocol");
      }
    }

    // Require either extraction_schema or extraction_prompt
    const schema = args.extraction_schema ?? source.extraction_schema;
    const prompt = args.extraction_prompt ?? source.extraction_prompt;
    if (!schema && !prompt) {
      throw new Error(
        "Either extraction_schema or extraction_prompt must be provided",
      );
    }

    const patch: Record<string, unknown> = {};
    if (args.url !== undefined) patch.url = args.url.trim();
    if (args.source_name !== undefined) patch.source_name = args.source_name.trim();
    if (args.extraction_schema !== undefined) patch.extraction_schema = args.extraction_schema;
    if (args.extraction_prompt !== undefined) patch.extraction_prompt = args.extraction_prompt;
    if (args.mode !== undefined) patch.mode = args.mode;
    if (args.field_map !== undefined) patch.field_map = args.field_map;
    if (args.constants !== undefined) patch.constants = args.constants;
    if (args.enabled !== undefined) patch.enabled = args.enabled;

    await ctx.db.patch(args.id, patch);
  },
});

/**
 * Remove a scrape source. Caller must be the owner of the parent dataset.
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
 * Toggle the enabled state of a scrape source. Caller must be the owner.
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
 * after a scrape completes.
 */
export const recordRun = internalMutation({
  args: {
    id: v.id("scrapeSources"),
    status: v.union(v.literal("success"), v.literal("error")),
    error: v.optional(v.string()),
    rowsWritten: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.id);
    if (!source) throw new Error("Scrape source not found");

    await ctx.db.patch(args.id, {
      lastRunAt: Date.now(),
      lastRunStatus: args.status,
      lastRunError: args.error,
      lastRunRowsWritten: args.rowsWritten,
    });
  },
});
