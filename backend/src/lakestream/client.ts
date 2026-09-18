import { env } from "../env.js";

export interface ExtractionField {
  name: string;
  selector: string;
  attribute?: string;
  type?: string;
  transform?: string;
}

export interface ExtractionSchema {
  name?: string;
  fields: ExtractionField[];
  list_selector?: string;
  description?: string;
}

export interface ScrapeRequest {
  url: string;
  schema?: ExtractionSchema;
  prompt?: string;
  mode?: "css" | "ai" | "auto" | "prompt";
}

export interface ScrapeResult {
  success: boolean;
  data: Record<string, unknown> | Record<string, unknown>[];
  mode: string;
  fields_found?: string[];
  fields_missing?: string[];
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Extract data from a URL via LakeStream.
 *
 * Never throws — all failure modes (missing LAKESTREAM_URL, non-2xx,
 * timeout, network error) return { success: false, data: [], error }.
 */
export async function extractFromUrl(
  url: string,
  options: {
    schema?: ExtractionSchema;
    prompt?: string;
    mode?: "css" | "ai" | "auto" | "prompt";
    timeoutMs?: number;
  } = {},
): Promise<ScrapeResult> {
  const baseUrl = env.LAKESTREAM_URL;
  if (!baseUrl) {
    return {
      success: false,
      data: [],
      mode: "unknown",
      error: "LAKESTREAM_URL is not configured",
    };
  }

  const body: ScrapeRequest = { url };
  if (options.schema) body.schema = options.schema;
  if (options.prompt) body.prompt = options.prompt;
  if (options.mode) body.mode = options.mode;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const response = await fetch(`${baseUrl}/api/scrape/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "unknown");
      return {
        success: false,
        data: [],
        mode: "unknown",
        error: `LakeStream returned ${response.status}: ${text.slice(0, 500)}`,
      };
    }

    const result = (await response.json()) as ScrapeResult;
    return result;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        success: false,
        data: [],
        mode: "unknown",
        error: `LakeStream request timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      data: [],
      mode: "unknown",
      error: `LakeStream request failed: ${message}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Health check — returns true if LakeStream is reachable.
 */
export async function pingLakeStream(): Promise<boolean> {
  const baseUrl = env.LAKESTREAM_URL;
  if (!baseUrl) return false;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const response = await fetch(`${baseUrl}/api/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}
