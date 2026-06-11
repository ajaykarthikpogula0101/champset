import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

const FETCH_TIMEOUT_MS = 30_000;

// Open-source web backend (replaces the proprietary TinyFish API):
//   search → self-hosted SearXNG metasearch (aggregates Google/Bing/DDG/Brave),
//            no API key required.
//   fetch  → plain HTTP GET + Mozilla Readability main-content extraction,
//            converted to markdown. Fully local, no third-party service.
// SearXNG runs as a Docker service; the backend reaches it at http://searxng:8080.
const SEARXNG_URL = (process.env.SEARXNG_URL || "http://searxng:8080").replace(/\/$/, "");

// A realistic desktop UA reduces bot-blocking on plain fetches.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const searchResultSchema = z.object({
  title: z.string(),
  snippet: z.string(),
  url: z.string(),
});

export const searchWebTool = createTool({
  id: "search_web",
  description:
    'Search the web for information. Returns a list of results with titles, snippets, and URLs. Call with: {"query": "your search terms"}',
  inputSchema: z.object({
    query: z.string().describe("The search query string"),
  }),
  outputSchema: z.object({
    results: z.array(searchResultSchema).optional(),
    error: z.string().optional(),
  }),
  execute: async ({ query }) => {
    if (!query?.trim())
      return { error: "query is required and cannot be empty." };

    const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json`;
    console.log(`[search_web] Searching SearXNG: "${query}"`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const body = await res.text();
        console.error(`[search_web] SearXNG error ${res.status}:`, body.slice(0, 200));
        if (res.status === 429)
          return { error: "Search rate limit hit. Wait a moment, or skip web search and use synthetic data." };
        if (res.status === 403)
          return { error: "SearXNG rejected the request (JSON format may be disabled in settings.yml). Use synthetic data." };
        return { error: `Search backend returned HTTP ${res.status}. Try a different query or use synthetic data.` };
      }

      const data = await res.json();
      const results = (data.results ?? [])
        .slice(0, 10)
        .map((r: Record<string, unknown>) => ({
          title: (r.title as string) ?? "",
          snippet: ((r.content as string) ?? "").trim(),
          url: (r.url as string) ?? "",
        }))
        .filter((r: { url: string }) => r.url);

      console.log(`[search_web] Got ${results.length} results`);
      if (results.length === 0)
        return { results: [], error: "No results found for this query. Try a broader search or use synthetic data." };
      return { results };
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === "AbortError")
        return { error: "Search timed out. Skip web search and use synthetic data." };
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[search_web] Failed:`, msg);
      // ECONNREFUSED → SearXNG container not running.
      if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed"))
        return { error: "Search backend (SearXNG) is unreachable. Skip web search and use synthetic data." };
      return { error: `Search failed: ${msg}. Skip web search and use synthetic data.` };
    }
  },
});

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

export const fetchPageTool = createTool({
  id: "fetch_page",
  description:
    'Fetch a web page and extract its content as clean markdown text. Call with: {"url": "https://example.com/page"}',
  inputSchema: z.object({
    url: z.string().describe("The full URL to fetch, starting with https://"),
  }),
  outputSchema: z.object({
    title: z.string().optional(),
    text: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ url: targetUrl }) => {
    if (!targetUrl?.trim())
      return { error: "url is required and cannot be empty." };
    if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://"))
      return { error: `Invalid URL "${targetUrl}". Must start with http:// or https://.` };

    console.log(`[fetch_page] Fetching: ${targetUrl}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(targetUrl, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        redirect: "follow",
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        if (res.status === 404)
          return { error: "Page not found (404). The URL may be outdated. Try a different one." };
        if (res.status === 403 || res.status === 401)
          return { error: "This site blocks automated access. Use the search snippet data instead." };
        if (res.status === 429)
          return { error: "Fetch rate limit hit. Use data from search snippets instead." };
        return { error: `Site returned HTTP ${res.status}. Try a different URL or use search snippet data.` };
      }

      const contentType = res.headers.get("content-type") ?? "";
      const raw = await res.text();

      // Non-HTML (JSON, plain text, CSV…) — return as-is, truncated.
      if (!contentType.includes("html")) {
        return finalize(undefined, raw);
      }

      // Parse + extract main article content. JSDOM does NOT execute page
      // scripts by default, so this is safe against malicious page JS.
      const dom = new JSDOM(raw, { url: targetUrl });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();

      if (article?.content) {
        const markdown = turndown.turndown(article.content);
        return finalize(article.title ?? undefined, markdown);
      }

      // Readability couldn't isolate an article — fall back to body text.
      const bodyText = dom.window.document.body?.textContent?.trim() ?? "";
      if (bodyText) return finalize(dom.window.document.title || undefined, bodyText);

      return { error: "Page loaded but had no extractable text content. Try a different URL." };
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === "AbortError")
        return { error: "Page fetch timed out. Try a different URL or use search snippet data." };
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[fetch_page] Failed:`, msg);
      return { error: `Fetch failed: ${msg}. Use data from search snippets instead.` };
    }
  },
});

function finalize(title: string | undefined, text: string): { title?: string; text: string } {
  const cleaned = text.replace(/\n{3,}/g, "\n\n").trim();
  const MAX_CHARS = 15000;
  const out =
    cleaned.length > MAX_CHARS
      ? cleaned.slice(0, MAX_CHARS) + `\n\n[Truncated — showing first ${MAX_CHARS} of ${cleaned.length} chars]`
      : cleaned;
  console.log(`[fetch_page] Extracted ${cleaned.length} chars (returning ${out.length})`);
  return { title, text: out };
}
