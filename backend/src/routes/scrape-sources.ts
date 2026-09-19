import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { convex, internal } from "../convex.js";
import {
  getBlogArticles,
  lakeStreamDomain,
  pingLakeStream,
  startBlogScrape,
  waitForScrape,
} from "../lakestream/client.js";
import { mapItemToRow, isWritableRow } from "../pipeline/row-mapping.js";
import type { Column } from "../pipeline/row-mapping.js";
import { scoreRow } from "../pipeline/accuracy.js";

/**
 * Blog scraping sources backed by LakeStream.
 *
 * A source is a blog/domain URL. Running it starts a LakeStream job that
 * discovers the site's blog articles and extracts each one; the extracted
 * articles are then mapped onto the dataset's columns and inserted as rows.
 *
 * Register these routes inside the authenticated route group. Caller must
 * have already applied the `requireAuth` preHandler.
 */
export async function registerScrapeRoutes(
  instance: FastifyInstance,
): Promise<void> {
  // ─── List blog sources for a dataset ──────────────────────────
  instance.get("/datasets/:datasetId/sources", async (req, reply) => {
    const { datasetId } = req.params as { datasetId: string };
    const userId = req.auth!.userId;

    try {
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
      req.log.error(err, "Failed to list blog sources");
      return reply.code(500).send({ error: "Failed to list sources" });
    }
  });

  // ─── Create a blog source ─────────────────────────────────────
  instance.post("/datasets/:datasetId/sources", async (req, reply) => {
    const { datasetId } = req.params as { datasetId: string };
    const userId = req.auth!.userId;
    const body = req.body as {
      url?: string;
      source_name?: string;
      max_pages?: number;
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
    if (body.max_pages !== undefined) {
      const n = body.max_pages;
      if (!Number.isInteger(n) || n < 1 || n > 500) {
        return reply
          .code(400)
          .send({ error: "max_pages must be between 1 and 500" });
      }
    }

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
        max_pages: body.max_pages,
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
      if (msg.includes("Invalid") || msg.includes("must be")) {
        return reply.code(400).send({ error: msg });
      }
      req.log.error(err, "Failed to create blog source");
      return reply.code(500).send({ error: "Failed to create source" });
    }
  });

  // ─── Update a blog source ─────────────────────────────────────
  instance.patch("/sources/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      url?: string;
      source_name?: string;
      max_pages?: number;
      field_map?: Record<string, string>;
      constants?: Record<string, string>;
      enabled?: boolean;
    };

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
    if (body.max_pages !== undefined) {
      const n = body.max_pages;
      if (!Number.isInteger(n) || n < 1 || n > 500) {
        return reply
          .code(400)
          .send({ error: "max_pages must be between 1 and 500" });
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
      if (msg.includes("Invalid") || msg.includes("must be")) {
        return reply.code(400).send({ error: msg });
      }
      req.log.error(err, "Failed to update blog source");
      return reply.code(500).send({ error: "Failed to update source" });
    }
  });

  // ─── Delete a blog source ─────────────────────────────────────
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
      req.log.error(err, "Failed to delete blog source");
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
      req.log.error(err, "Failed to toggle blog source");
      return reply.code(500).send({ error: "Failed to toggle source" });
    }
  });

  // ─── Scrape run: start a LakeStream blog job per enabled source ─
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
        return { success: true, sourcesRun: 0, jobs: [] };
      }

      const columns = dataset.columns as Column[];
      const jobs: Array<{
        sourceId: string;
        sourceName: string;
        jobId?: string;
        error?: string;
      }> = [];

      for (const source of sources) {
        const started = await startBlogScrape(lakeStreamDomain(source.url), {
          maxPages: source.max_pages,
        });

        if (!started.success || !started.jobId) {
          try {
            await convex.mutation(internal.scrapeSources.recordRun, {
              id: source._id,
              status: "error",
              error: started.error ?? "Failed to start LakeStream job",
            });
          } catch {
            // Best effort telemetry
          }
          jobs.push({
            sourceId: source._id,
            sourceName: source.source_name,
            error: started.error ?? "Failed to start LakeStream job",
          });
          continue;
        }

        const jobId = started.jobId;

        try {
          await convex.mutation(internal.scrapeSources.recordRun, {
            id: source._id,
            status: "running",
            jobId,
          });
        } catch {
          // Best effort telemetry
        }

        jobs.push({
          sourceId: source._id,
          sourceName: source.source_name,
          jobId,
        });

        // Finalize in the background: poll to completion, then import rows.
        void finalizeSourceJob({
          sourceId: source._id,
          sourceName: source.source_name,
          sourceUrl: source.url,
          jobId,
          datasetId,
          datasetName: dataset.name,
          datasetDescription: dataset.description,
          columns,
          fieldMap: source.field_map,
          constants: source.constants,
          log: req.log,
        });
      }

      return {
        success: jobs.every((job) => !job.error),
        sourcesRun: sources.length,
        jobs,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found") || msg.includes("Dataset not found")) {
        return reply.code(404).send({ error: "Dataset not found" });
      }
      req.log.error(err, "Blog scrape run failed");
      return reply.code(500).send({ error: "Scrape run failed" });
    }
  });

  // ─── LakeStream health check ──────────────────────────────────
  instance.get("/lakestream/health", async (_req, _reply) => {
    const healthy = await pingLakeStream();
    return { healthy };
  });
}

/**
 * Wait for a LakeStream blog job to finish, import its article records as
 * dataset rows, then record the outcome on the source.
 *
 * Runs detached from the HTTP request. Idempotent-ish: re-importing the same
 * job would be rejected by the dataset's duplicate check, not double-written.
 */
async function finalizeSourceJob(params: {
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  jobId: string;
  datasetId: string;
  datasetName?: string;
  datasetDescription?: string;
  columns: Column[];
  fieldMap?: Record<string, string>;
  constants?: Record<string, string>;
  log: FastifyBaseLogger;
}): Promise<void> {
  const {
    sourceId,
    sourceName,
    sourceUrl,
    jobId,
    datasetId,
    datasetName,
    datasetDescription,
    columns,
    fieldMap,
    constants,
    log,
  } = params;

  try {
    const status = await waitForScrape(jobId);

    if (status.status !== "completed") {
      await recordRun(sourceId, "error", {
        error: status.error ?? `LakeStream job ${status.status}`,
      });
      log.warn(
        { sourceId, jobId, status: status.status },
        "LakeStream blog job did not complete",
      );
      return;
    }

    const articles = await getBlogArticles(jobId);
    let written = 0;

    for (const article of articles) {
      const item: Record<string, unknown> = {
        ...article.metadata,
        url: article.url,
        title: article.title,
        published_date: article.publishedDate,
      };

      const mapped = mapItemToRow(item, columns, { fieldMap, constants });
      if (!isWritableRow(mapped.data)) continue;

      const accuracyScore = await scoreRow({
        datasetName,
        description: datasetDescription,
        columns,
        data: mapped.data,
        sources: [sourceUrl],
      });

      try {
        await convex.mutation(internal.datasetRows.insert, {
          datasetId,
          data: mapped.data,
          sources: [sourceUrl],
          howFound: `blog:${sourceName}`,
          ...(accuracyScore !== undefined ? { accuracyScore } : {}),
        });
        written++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // Duplicates and row-limit rejections are expected; anything else is
        // logged but doesn't abort the remaining articles.
        if (!msg.startsWith("Duplicate:") && !msg.includes("Row limit reached")) {
          log.warn(
            { err, sourceId, jobId, articleUrl: article.url },
            "Blog row insert failed",
          );
        }
      }
    }

    await recordRun(sourceId, "success", { rowsWritten: written });
    log.info(
      { sourceId, jobId, articles: articles.length, written },
      "LakeStream blog job imported",
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, sourceId, jobId }, "Failed to finalize blog scrape job");
    await recordRun(sourceId, "error", { error: msg });
  }
}

async function recordRun(
  sourceId: string,
  status: "success" | "error",
  extra: { error?: string; rowsWritten?: number },
): Promise<void> {
  try {
    await convex.mutation(internal.scrapeSources.recordRun, {
      id: sourceId,
      status,
      error: extra.error,
      rowsWritten: extra.rowsWritten,
    });
  } catch {
    // Best effort telemetry — never fail the run over it
  }
}
