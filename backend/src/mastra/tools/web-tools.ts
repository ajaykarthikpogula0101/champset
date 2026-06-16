// Mastra tool factory for the agent web layer.
//
// `search_web` and `fetch_page` keep identical ids, schemas, and descriptions
// regardless of which engine is active, so the agents are completely unaware
// of the SearXNG-vs-Exa toggle. The active provider is chosen per run (see
// agents/populate.ts, investigate.ts, refresh.ts) and bound here.
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  getWebProvider,
  resolveProviderName,
  type WebProvider,
} from "./web-providers/index.js";

const searchResultSchema = z.object({
  title: z.string(),
  snippet: z.string(),
  url: z.string(),
});

/**
 * Build the `search_web` + `fetch_page` tools bound to a specific web
 * provider. A fresh pair is built per agent so each run can use a different
 * engine without any shared mutable state.
 */
export function buildWebTools(provider: WebProvider) {
  const search_web = createTool({
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
    execute: async ({ query }) => provider.searchWeb(query),
  });

  const fetch_page = createTool({
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
    execute: async ({ url }) => provider.fetchPage(url),
  });

  return { search_web, fetch_page };
}

// Back-compat default singletons bound to the env-default provider. Used by
// Mastra Studio and any importer that doesn't run inside an authed workflow.
const defaults = buildWebTools(getWebProvider(resolveProviderName()));
export const searchWebTool = defaults.search_web;
export const fetchPageTool = defaults.fetch_page;
