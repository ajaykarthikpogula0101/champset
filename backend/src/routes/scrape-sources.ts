import type { FastifyInstance } from "fastify";
import { convex, internal } from "../convex.js";
import { extractFromUrl, pingLakeStream } from "../lakestream/client.js";
import {
  mapItemToRow,
  toItems,
  isWritableRow,
  findUnmappedColumns,
  findUnusedExtractedKeys,
} from "../pipeline/row-mapping.js";

/**
 * Register scrape-source routes inside the authenticated route group.
 *
 * Caller must have already applied the `requireAuth` preHandler.
 */
export async function registerScrapeRoutes(
  instance: FastifyInstance,
): Promise<void> {
  // ─── List sources for a dataset ───────────────────────────────
  instance.get("/datasets/:datasetId/sources", async (req, reply) => {
    const { datasetId } = req.params as { datasetId: string };
    const userId = req.auth!.userId;

    try {
      // Authorize via getForUser
      const dataset = await convex.query(internal.datasets.getForUser, {
        datasetId,
        userId,
      });
      if (!dataset) {
        return reply.code(404).send({ error: "Dataset not found" });
      }

      const sources = await convex.query(
        internal.scrapeSources.listByDataset,
        { datasetId },
      );
      return { sources };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found") || msg.includes("Dataset not found")) {
        return reply.code(404).send({ error: "Dataset not found" });
      }
      req.log.error(err, "Failed to list scrape sources");
      return reply.code(500).send({ error: "Failed to list sources" });
    }
  });

  // ─── Create a source ──────────────────────────────────────────
  instance.post("/datasets/:datasetId/sources", async (req, reply) => {
    const { datasetId } = req.params as { datasetId: string };
    const userId = req.auth!.userId;
    const body = req.body as {
      url?: string;
      source_name?: string;
      extraction_schema?: unknown;
      extraction_prompt?: string;
      mode?: "css" | "ai" | "auto" | "prompt";
      field_map?: Record<string, string>;
      constants?: Record<string, string>;
      enabled?: boolean;
    };

    if (!body?.url || typeof body.url !== "string") {
      return reply.code(400).send({ error: "url is required" });
    }
    if (!body?.source_name || typeof body.source_name !== "string") {
      return reply.code(400).send({ error: "source_name is required" });
    }
    if (!body.extraction_schema && !body.extraction_prompt) {
      return reply
        .code(400)
        .send({
          error: "Either extraction_schema or extraction_prompt must be provided",
        });
    }

    // Validate URL parses and is http/https
    try {
      const parsed = new URL(body.url);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return reply
          .code(400)
          .send({ error: "URL must use http or https protocol" });
      }
    } catch {
      return reply.code(400).send({ error: "Invalid URL" });
    }

    try {
      // Authorize via getForUser
      const dataset = await convex.query(internal.datasets.getForUser, {
        datasetId,
        userId,
      });
      if (!dataset) {
        return reply.code(404).send({ error: "Dataset not found" });
      }

      const id = await convex.mutation(internal.scrapeSources.insert, {
        datasetId,
        url: body.url.trim(),
        source_name: body.source_name.trim(),
        extraction_schema: body.extraction_schema,
        extraction_prompt: body.extraction_prompt,
        mode: body.mode,
        field_map: body.field_map,
        constants: body.constants,
        enabled: body.enabled ?? true,
      });

      return reply.code(201).send({ id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found") || msg.includes("Dataset not found")) {
        return reply.code(404).send({ error: "Dataset not found" });
      }
      if (msg.includes("Invalid") || msg.includes("must be provided")) {
        return reply.code(400).send({ error: msg });
      }
      req.log.error(err, "Failed to create scrape source");
      return reply.code(500).send({ error: "Failed to create source" });
    }
  });

  // ─── Update a source ──────────────────────────────────────────
  instance.patch("/sources/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      url?: string;
      source_name?: string;
      extraction_schema?: unknown;
      extraction_prompt?: string;
      mode?: "css" | "ai" | "auto" | "prompt";
      field_map?: Record<string, string>;
      constants?: Record<string, string>;
      enabled?: boolean;
    };

    // Validate URL if provided
    if (body.url) {
      try {
        const parsed = new URL(body.url);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          return reply
            .code(400)
            .send({ error: "URL must use http or https protocol" });
        }
      } catch {
        return reply.code(400).send({ error: "Invalid URL" });
      }
    }

    try {
      await convex.mutation(internal.scrapeSources.update, {
        id,
        ...body,
      });
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) {
        return reply.code(404).send({ error: "Source not found" });
      }
      if (msg.includes("Invalid") || msg.includes("must be provided")) {
        return reply.code(400).send({ error: msg });
      }
      req.log.error(err, "Failed to update scrape source");
      return reply.code(500).send({ error: "Failed to update source" });
    }
  });

  // ─── Delete a source ──────────────────────────────────────────
  instance.delete("/sources/:id", async (req, reply) => {
    const { id } = req.params as { id: string };

    try {
      await convex.mutation(internal.scrapeSources.remove, { id });
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) {
        return reply.code(404).send({ error: "Source not found" });
      }
      req.log.error(err, "Failed to delete scrape source");
      return reply.code(500).send({ error: "Failed to delete source" });
    }
  });

  // ─── Toggle source enabled/disabled ───────────────────────────
  instance.post("/sources/:id/toggle", async (req, reply) => {
    const { id } = req.params as { id: string };

    try {
      await convex.mutation(internal.scrapeSources.toggle, { id });
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) {
        return reply.code(404).send({ error: "Source not found" });
      }
      req.log.error(err, "Failed to toggle scrape source");
      return reply.code(500).send({ error: "Failed to toggle source" });
    }
  });

  // ─── Preview: dry-run extraction ──────────────────────────────
  instance.post("/datasets/:datasetId/sources/preview", async (req, reply) => {
    const { datasetId } = req.params as { datasetId: string };
    const userId = req.auth!.userId;
    const body = req.body as {
      url: string;
      extraction_schema?: unknown;
      extraction_prompt?: string;
      mode?: "css" | "ai" | "auto" | "prompt";
      field_map?: Record<string, string>;
      constants?: Record<string, string>;
    };

    if (!body?.url) {
      return reply.code(400).send({ error: "url is required" });
    }

    try {
      // Authorize via getForUser
      const dataset = await convex.query(internal.datasets.getForUser, {
        datasetId,
        userId,
      });
      if (!dataset) {
        return reply.code(404).send({ error: "Dataset not found" });
      }

      if (!dataset.columns || dataset.columns.length === 0) {
        return reply
          .code(400)
          .send({ error: "Dataset has no columns defined" });
      }

      // Extract from URL
      const result = await extractFromUrl(body.url, {
        schema: body.extraction_schema as Parameters<
          typeof extractFromUrl
        >[1]["schema"],
        prompt: body.extraction_prompt,
        mode: body.mode,
      });

      if (!result.success) {
        return reply.code(422).send({
          error: result.error ?? "Extraction failed",
          raw_items: [],
          mapped_rows: [],
          unmapped_columns: dataset.columns.map(
            (c: { name: string }) => c.name,
          ),
          unused_extracted_keys: [],
        });
      }

      const items = toItems(result.data);

      // Map each item
      const mappedRows = items.map((item) =>
        mapItemToRow(item, dataset.columns, {
          fieldMap: body.field_map,
          constants: body.constants,
        }),
      );

      const unmappedColumns = findUnmappedColumns(dataset.columns, items);
      const unusedExtractedKeys = findUnusedExtractedKeys(
        dataset.columns,
        items,
        body.field_map,
      );

      return {
        raw_items: items,
        mapped_rows: mappedRows,
        unmapped_columns: unmappedColumns,
        unused_extracted_keys: unusedExtractedKeys,
        mode: result.mode,
        fields_found: result.fields_found,
        fields_missing: result.fields_missing,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found") || msg.includes("Dataset not found")) {
        return reply.code(404).send({ error: "Dataset not found" });
      }
      req.log.error(err, "Preview extraction failed");
      return reply.code(500).send({ error: "Preview failed" });
    }
  });

  // ─── Scrape run: process all enabled sources ──────────────────
  instance.post("/datasets/:datasetId/scrape", async (req, reply) => {
    const { datasetId } = req.params as { datasetId: string };
    const userId = req.auth!.userId;

    try {
      // 1. Authorize FIRST as the calling user
      const dataset = await convex.query(internal.datasets.getForUser, {
        datasetId,
        userId,
      });
      if (!dataset) {
        return reply.code(404).send({ error: "Dataset not found" });
      }

      // 2. 400 if dataset has no columns
      if (!dataset.columns || dataset.columns.length === 0) {
        return reply
          .code(400)
          .send({ error: "Dataset has no columns defined" });
      }

      // 3. Get all enabled sources
      const sources = await convex.query(
        internal.scrapeSources.listEnabledInternal,
        { datasetId },
      );

      if (sources.length === 0) {
        return {
          success: true,
          sourcesRun: 0,
          failed: 0,
          rowsWritten: 0,
          rowLimitReached: false,
          results: [],
        };
      }

      const columns = dataset.columns as Array<{
        name: string;
        type: string;
        isPrimaryKey?: boolean;
      }>;
      const results: Array<{
        sourceId: string;
        sourceName: string;
        url: string;
        success: boolean;
        rowsExtracted: number;
        rowsWritten: number;
        duplicates: number;
        skipped: number;
        error?: string;
      }> = [];
      let totalRowsWritten = 0;
      let totalFailed = 0;
      let rowLimitReached = false;

      for (const source of sources) {
        const sourceResult = {
          sourceId: source._id,
          sourceName: source.source_name,
          url: source.url,
          success: false,
          rowsExtracted: 0,
          rowsWritten: 0,
          duplicates: 0,
          skipped: 0,
          error: undefined as string | undefined,
        };

        try {
          // Extract from URL
          const extraction = await extractFromUrl(source.url, {
            schema: source.extraction_schema,
            prompt: source.extraction_prompt,
            mode: source.mode,
          });

          if (!extraction.success) {
            sourceResult.error = extraction.error ?? "Extraction failed";
            sourceResult.success = false;
            results.push(sourceResult);
            totalFailed++;

            // Record failed run
            try {
              await convex.mutation(internal.scrapeSources.recordRun, {
                id: source._id,
                status: "error",
                error: sourceResult.error,
                rowsWritten: 0,
              });
            } catch {
              // Best effort telemetry — don't fail the request
            }
            continue;
          }

          const items = toItems(extraction.data);
          sourceResult.rowsExtracted = items.length;

          let written = 0;
          let duplicates = 0;
          let skipped = 0;

          for (const item of items) {
            if (rowLimitReached) {
              skipped++;
              continue;
            }

            try {
              const mapped = mapItemToRow(item, columns, {
                fieldMap: source.field_map,
                constants: source.constants,
              });

              if (!isWritableRow(mapped.data)) {
                skipped++;
                continue;
              }

              await convex.mutation(internal.datasetRows.insert, {
                datasetId,
                data: mapped.data,
                sources: [source.url],
                howFound: `scrape:${source.source_name}`,
              });

              written++;
              totalRowsWritten++;
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              if (msg.startsWith("Duplicate:")) {
                duplicates++;
                sourceResult.duplicates++;
              } else if (msg.includes("Row limit reached")) {
                rowLimitReached = true;
                skipped++;
              } else {
                // Unknown error on this item — count as skipped, continue
                skipped++;
                req.log.warn(
                  { err, sourceId: source._id, url: source.url },
                  "Row insert failed (non-duplicate, non-limit)",
                );
              }
            }
          }

          sourceResult.success = true;
          sourceResult.rowsWritten = written;
          sourceResult.skipped = skipped;
          sourceResult.duplicates = duplicates;

          // Record successful run
          try {
            await convex.mutation(internal.scrapeSources.recordRun, {
              id: source._id,
              status: "success",
              rowsWritten: written,
            });
          } catch {
            // Best effort telemetry
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          sourceResult.error = msg;
          sourceResult.success = false;
          totalFailed++;

          // Record failed run
          try {
            await convex.mutation(internal.scrapeSources.recordRun, {
              id: source._id,
              status: "error",
              error: msg,
              rowsWritten: 0,
            });
          } catch {
            // Best effort telemetry
          }
        }

        results.push(sourceResult);
      }

      return {
        success: totalFailed === 0,
        sourcesRun: sources.length,
        failed: totalFailed,
        rowsWritten: totalRowsWritten,
        rowLimitReached,
        results,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found") || msg.includes("Dataset not found")) {
        return reply.code(404).send({ error: "Dataset not found" });
      }
      req.log.error(err, "Scrape run failed");
      return reply.code(500).send({ error: "Scrape run failed" });
    }
  });

  // ─── LakeStream health check ──────────────────────────────────
  instance.get("/lakestream/health", async (_req, reply) => {
    const healthy = await pingLakeStream();
    return { healthy };
  });
}
