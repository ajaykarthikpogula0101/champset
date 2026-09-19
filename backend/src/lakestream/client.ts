import { env } from "../env.js";

/**
 * LakeStream blog-scraping client.
 *
 * ChampSet integrates ONLY LakeStream's blog functionality: given a domain,
 * LakeStream discovers the site's blog/ article URLs and extracts each
 * article. That is a job-based flow:
 *
 *   1. POST /api/scrape/execute          -> { job_id, status }
 *   2. GET  /api/scrape/status/{job_id}  -> poll until terminal
 *   3. GET  /api/exports/json/{job_id}   -> article records (needs X-API-Key)
 *
 * Functions never throw on transport/HTTP errors — they return typed
 * failure results so the caller can record a run error instead of crashing.
 */

const REQUEST_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 20 * 60 * 1000;
const STATUS_POLL_MS = 5_000;

const BLOG_DATA_TYPES = ["blog_url", "article"];

export type LakeStreamJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface StartScrapeResult {
  success: boolean;
  jobId?: string;
  status?: LakeStreamJobStatus;
  error?: string;
}

export interface ScrapeStatus {
  jobId: string;
  status: LakeStreamJobStatus;
  dataCount: number;
  pagesScraped: number;
  error?: string;
}

export interface BlogArticle {
  url: string | null;
  title: string | null;
  publishedDate: string | null;
  scrapedAt: string | null;
  metadata: Record<string, unknown>;
}

function authHeaders(): Record<string, string> {
  return env.LAKESTREAM_API_KEY
    ? { "X-API-Key": env.LAKESTREAM_API_KEY }
    : {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reduce a user-supplied blog URL to the hostname LakeStream's job API
 * expects (it crawls `https://<domain>` and discovers blog URLs itself).
 */
export function lakeStreamDomain(url: string): string {
  const trimmed = url.trim();
  try {
    const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
    return new URL(withScheme).hostname;
  } catch {
    return trimmed;
  }
}

async function fetchJson(
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; body: unknown; error?: string }> {
  const baseUrl = env.LAKESTREAM_URL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        status: response.status,
        body: null,
        error: `LakeStream returned ${response.status}: ${text.slice(0, 300)}`,
      };
    }
    const body = await response.json().catch(() => null);
    return { ok: true, status: response.status, body };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        status: 0,
        body: null,
        error: `LakeStream request timed out after ${timeoutMs}ms`,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 0,
      body: null,
      error: `LakeStream request failed: ${message}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Start a blog scrape job for a domain. `domain` should be a hostname
 * (use `lakeStreamDomain` to derive one from a URL).
 */
export async function startBlogScrape(
  domain: string,
  options: { maxPages?: number } = {},
): Promise<StartScrapeResult> {
  const result = await fetchJson(
    "/api/scrape/execute",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        domain,
        data_types: BLOG_DATA_TYPES,
        max_pages: options.maxPages ?? 100,
      }),
    },
    REQUEST_TIMEOUT_MS,
  );

  if (!result.ok) {
    return { success: false, error: result.error };
  }

  const body = result.body as { job_id?: string; status?: LakeStreamJobStatus };
  if (!body?.job_id) {
    return { success: false, error: "LakeStream did not return a job id" };
  }
  return { success: true, jobId: body.job_id, status: body.status };
}

/**
 * Fetch the current status of a scrape job. Returns null when the job is
 * unknown (404).
 */
export async function getScrapeStatus(
  jobId: string,
): Promise<ScrapeStatus | null> {
  const result = await fetchJson(
    `/api/scrape/status/${jobId}`,
    { method: "GET", headers: authHeaders() },
    REQUEST_TIMEOUT_MS,
  );

  if (!result.ok) {
    if (result.status === 404) return null;
    throw new Error(result.error ?? "Failed to fetch LakeStream job status");
  }

  const body = result.body as {
    status?: LakeStreamJobStatus;
    data_count?: number;
    pages_scraped?: number;
    error_message?: string | null;
  };
  return {
    jobId,
    status: body?.status ?? "running",
    dataCount: body?.data_count ?? 0,
    pagesScraped: body?.pages_scraped ?? 0,
    error: body?.error_message ?? undefined,
  };
}

/**
 * Poll a scrape job until it reaches a terminal state, or the timeout
 * elapses. Returns the last observed status (never throws).
 */
export async function waitForScrape(
  jobId: string,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<ScrapeStatus> {
  const timeoutMs = options.timeoutMs ?? STATUS_TIMEOUT_MS;
  const pollMs = options.pollMs ?? STATUS_POLL_MS;
  const deadline = Date.now() + timeoutMs;

  let last: ScrapeStatus = {
    jobId,
    status: "running",
    dataCount: 0,
    pagesScraped: 0,
  };

  while (Date.now() < deadline) {
    try {
      const status = await getScrapeStatus(jobId);
      if (status === null) {
        return {
          jobId,
          status: "failed",
          dataCount: 0,
          pagesScraped: 0,
          error: "LakeStream job not found",
        };
      }
      last = status;
      if (
        status.status === "completed" ||
        status.status === "failed" ||
        status.status === "cancelled"
      ) {
        return status;
      }
    } catch (err: unknown) {
      last = {
        ...last,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    await sleep(pollMs);
  }

  return {
    ...last,
    status: "failed",
    error: `Timed out waiting for LakeStream job after ${Math.round(
      timeoutMs / 1000,
    )}s`,
  };
}

/**
 * Fetch the article records produced by a completed scrape job.
 * Requires LAKESTREAM_API_KEY (the exports endpoint is authenticated).
 * Returns [] when the job produced no data (404).
 */
export async function getBlogArticles(jobId: string): Promise<BlogArticle[]> {
  const result = await fetchJson(
    `/api/exports/json/${jobId}`,
    { method: "GET", headers: authHeaders() },
    REQUEST_TIMEOUT_MS,
  );

  if (!result.ok) {
    if (result.status === 404) return [];
    throw new Error(result.error ?? "Failed to fetch LakeStream export");
  }

  const body = result.body as {
    data?: Array<{
      data_type?: string;
      url?: string | null;
      title?: string | null;
      published_date?: string | null;
      scraped_at?: string | null;
      metadata?: Record<string, unknown> | null;
    }>;
  };

  return (body?.data ?? [])
    .filter((record) => record.data_type === "article")
    .map((record) => ({
      url: record.url ?? null,
      title: record.title ?? null,
      publishedDate: record.published_date ?? null,
      scrapedAt: record.scraped_at ?? null,
      metadata: record.metadata ?? {},
    }));
}

/**
 * Health check — true when LakeStream responds.
 */
export async function pingLakeStream(): Promise<boolean> {
  try {
    const result = await fetchJson(
      "/api/health",
      { method: "GET" },
      REQUEST_TIMEOUT_MS,
    );
    return result.ok;
  } catch {
    return false;
  }
}
