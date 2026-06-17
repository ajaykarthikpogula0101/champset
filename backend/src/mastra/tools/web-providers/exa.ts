// "Exa" web provider: all web access (search + page contents) goes through
// the Exa API instead of SearXNG + Readability. This is the B side of the
// A/B toggle. The agent pipeline (schema inference, verify, dedupe, score,
// insert) is identical to the SearXNG side - only the web layer changes,
// which is what makes the bake-off a clean apples-to-apples comparison.
//
// Endpoints (verified against docs.exa.ai, Jun 2026; smoke-tested live):
//   POST https://api.exa.ai/search    -> results[] { title, url, text }
//   POST https://api.exa.ai/contents  -> results[] { title, url, text }
// Auth: header `x-api-key: <EXA_API_KEY>`.
import { finalizeText, FETCH_TIMEOUT_MS } from "./text-util.js";
import type { WebProvider, SearchOutput, FetchOutput } from "./index.js";

const EXA_BASE = (process.env.EXA_BASE_URL || "https://api.exa.ai").replace(/\/$/, "");
const NUM_RESULTS = Number(process.env.EXA_NUM_RESULTS) || 10;
// "auto" lets Exa pick neural vs keyword. Override with EXA_SEARCH_TYPE.
const SEARCH_TYPE = process.env.EXA_SEARCH_TYPE || "auto";
// Snippet length per search result. Kept small to mirror SearXNG snippets and
// keep orchestrator token cost comparable; full text comes from fetch_page.
const SNIPPET_CHARS = Number(process.env.EXA_SNIPPET_CHARS) || 600;

function apiKey(): string {
  return process.env.EXA_API_KEY || "";
}

async function exaPost(path: string, body: unknown): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(`${EXA_BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-api-key": apiKey(),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

interface ExaResult {
  title?: string;
  url?: string;
  text?: string;
  summary?: string;
}

async function searchWeb(query: string): Promise<SearchOutput> {
  if (!query?.trim()) return { error: "query is required and cannot be empty." };
  if (!apiKey())
    return { error: "EXA_API_KEY is not set. Skip web search and use synthetic data." };

  console.log(`[search_web:exa] Searching Exa: "${query}"`);
  try {
    const res = await exaPost("/search", {
      query,
      type: SEARCH_TYPE,
      numResults: NUM_RESULTS,
      contents: { text: { maxCharacters: SNIPPET_CHARS } },
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[search_web:exa] error ${res.status}:`, body.slice(0, 200));
      if (res.status === 401 || res.status === 403)
        return { error: "Exa rejected the request (check EXA_API_KEY). Use synthetic data." };
      if (res.status === 429)
        return { error: "Exa rate limit hit. Wait a moment, or skip web search and use synthetic data." };
      return { error: `Exa search returned HTTP ${res.status}. Try a different query or use synthetic data.` };
    }

    const data = (await res.json()) as { results?: ExaResult[] };
    const results = (data.results ?? [])
      .map((r) => ({
        title: r.title ?? "",
        snippet: ((r.text ?? r.summary ?? "") as string).replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS),
        url: r.url ?? "",
      }))
      .filter((r) => r.url);

    console.log(`[search_web:exa] Got ${results.length} results`);
    if (results.length === 0)
      return { results: [], error: "No results found for this query. Try a broader search or use synthetic data." };
    return { results };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError")
      return { error: "Exa search timed out. Skip web search and use synthetic data." };
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[search_web:exa] Failed:`, msg);
    return { error: `Exa search failed: ${msg}. Skip web search and use synthetic data.` };
  }
}

async function fetchPage(targetUrl: string): Promise<FetchOutput> {
  if (!targetUrl?.trim()) return { error: "url is required and cannot be empty." };
  if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://"))
    return { error: `Invalid URL "${targetUrl}". Must start with http:// or https://.` };
  if (!apiKey())
    return { error: "EXA_API_KEY is not set. Use data from search snippets instead." };

  console.log(`[fetch_page:exa] Fetching via Exa contents: ${targetUrl}`);
  try {
    // livecrawl:"fallback" -> serve from Exa cache, live-crawl if uncached.
    const res = await exaPost("/contents", {
      urls: [targetUrl],
      text: true,
      livecrawl: "fallback",
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[fetch_page:exa] error ${res.status}:`, body.slice(0, 200));
      if (res.status === 401 || res.status === 403)
        return { error: "Exa rejected the request (check EXA_API_KEY). Use search snippet data instead." };
      if (res.status === 429)
        return { error: "Exa rate limit hit. Use data from search snippets instead." };
      return { error: `Exa contents returned HTTP ${res.status}. Try a different URL or use search snippet data.` };
    }

    const data = (await res.json()) as { results?: ExaResult[] };
    const first = data.results?.[0];
    const text = (first?.text ?? "").trim();
    if (!text)
      return { error: "Exa returned no extractable text for this URL. Try a different URL or use search snippets." };
    return finalizeText(first?.title ?? undefined, text);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError")
      return { error: "Exa page fetch timed out. Try a different URL or use search snippet data." };
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[fetch_page:exa] Failed:`, msg);
    return { error: `Exa fetch failed: ${msg}. Use data from search snippets instead.` };
  }
}

export function createExaProvider(): WebProvider {
  return { name: "exa", searchWeb, fetchPage };
}
