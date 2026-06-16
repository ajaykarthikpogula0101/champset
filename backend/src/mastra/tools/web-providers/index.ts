// Web provider registry. Two interchangeable backends for the agent web
// layer, selected per populate/update run:
//   - "searxng": owned SearXNG metasearch + Readability  (ChampSet proprietary)
//   - "exa":     Exa /search + /contents                  (Exa engine)
// Selection precedence is resolved upstream (per-Set > per-user default >
// SEARCH_PROVIDER env > "searxng") and passed in as a provider name.
import { searxngProvider } from "./searxng.js";
import { createExaProvider } from "./exa.js";

export type SearchProviderName = "searxng" | "exa";

export interface WebSearchResult {
  title: string;
  snippet: string;
  url: string;
}
export interface SearchOutput {
  results?: WebSearchResult[];
  error?: string;
}
export interface FetchOutput {
  title?: string;
  text?: string;
  error?: string;
}
export interface WebProvider {
  readonly name: SearchProviderName;
  searchWeb(query: string): Promise<SearchOutput>;
  fetchPage(url: string): Promise<FetchOutput>;
}

const VALID: readonly string[] = ["searxng", "exa"];

export function isProviderName(x: unknown): x is SearchProviderName {
  return typeof x === "string" && VALID.includes(x);
}

/** App-wide default when nothing more specific is set. */
export function defaultProviderName(): SearchProviderName {
  return isProviderName(process.env.SEARCH_PROVIDER)
    ? (process.env.SEARCH_PROVIDER as SearchProviderName)
    : "searxng";
}

/** Resolve a (possibly undefined) preference down to a concrete provider name. */
export function resolveProviderName(pref?: string | null): SearchProviderName {
  return isProviderName(pref) ? pref : defaultProviderName();
}

let exaSingleton: WebProvider | null = null;

export function getWebProvider(name: SearchProviderName): WebProvider {
  if (name === "exa") {
    if (!exaSingleton) exaSingleton = createExaProvider();
    return exaSingleton;
  }
  return searxngProvider;
}
