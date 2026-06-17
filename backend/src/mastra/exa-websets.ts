// Exa "Websets" populate path.
//
// When the Exa engine is selected, a dataset is built end to end by an Exa
// Webset instead of the SearXNG agent pipeline. A Webset is Exa's async
// find + verify + enrich system: you give it a natural language query, a
// target count, and one enrichment per column to extract. Exa finds entities,
// verifies them, and enriches each with the requested fields. We then map each
// Webset item to one dataset row and insert it through the same Convex
// mutation the agent uses, so quota and dedupe apply identically.
//
// This is intentionally a DIFFERENT populate strategy from the owned engine
// (which runs the agent pipeline). The dashboard toggle therefore switches the
// whole build strategy for a Set, not just a search call. SearXNG stays the
// owned default; Exa is the comparison.
//
// API: https://api.exa.ai/websets/v0  (auth header: x-api-key). Docs verified
// against the Websets reference, Jun 2026.
import { convex, internal } from "../convex.js";
import type { PopulateColumn } from "../pipeline/populate.js";

const BASE =
  (process.env.EXA_BASE_URL || "https://api.exa.ai").replace(/\/$/, "") +
  "/websets/v0";

// Websets are async; enrichment can take a while. Cap the wait so a stuck
// build does not hang the workflow forever.
const IDLE_TIMEOUT_MS = Number(process.env.EXA_WEBSETS_TIMEOUT_MS) || 300_000;
const POLL_MS = Number(process.env.EXA_WEBSETS_POLL_MS) || 4_000;

interface Logger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
}

function log(logger: Logger | undefined, msg: string): void {
  console.log(`[populate:exa-websets] ${msg}`);
  logger?.info?.(`[populate:exa-websets] ${msg}`);
}

function apiKey(): string {
  return process.env.EXA_API_KEY || "";
}

async function api(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-api-key": apiKey(),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

// Map a ChampSet column type to a Websets enrichment format.
function exaFormat(type: PopulateColumn["type"]): string {
  switch (type) {
    case "number":
      return "number";
    case "url":
      return "url";
    case "date":
      return "date";
    default:
      return "text";
  }
}

interface WebsetEnrichment {
  id: string;
  description?: string;
}
interface WebsetItem {
  id: string;
  properties?: {
    type?: string;
    url?: string;
    description?: string;
    [key: string]: unknown;
  };
  enrichments?: Array<{
    enrichmentId: string;
    result?: string[] | null;
  }>;
  evaluations?: Array<{
    references?: Array<{ url?: string }>;
  }>;
}
interface WebsetSearch {
  status?: string;
}
interface Webset {
  id: string;
  status?: string;
  searches?: WebsetSearch[];
  enrichments?: WebsetEnrichment[];
  items?: WebsetItem[];
}

function pickUrlColumn(columns: PopulateColumn[]): PopulateColumn | undefined {
  // Prefer a url-typed primary key, then any url column, then a PK.
  return (
    columns.find((c) => c.isPrimaryKey && c.type === "url") ||
    columns.find((c) => c.type === "url") ||
    columns.find((c) => c.isPrimaryKey)
  );
}

// Build the {column.name: value} row object for one Webset item.
function itemToRow(
  item: WebsetItem,
  urlCol: PopulateColumn | undefined,
  enrichCols: PopulateColumn[],
  enrichIdToName: Record<string, string>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const props = item.properties ?? {};
  // The entity block (e.g. props.company for a company, props.person for a
  // person) holds clean, canonical fields. Prefer these over enrichments:
  // asking Websets to "enrich" a field it already has (name, industry,
  // location, about) tends to return a raw page snippet instead of the clean
  // value, which is why Company Name was coming back as article text.
  const entity = (props[props.type ?? ""] as Record<string, unknown>) ?? {};

  if (urlCol && props.url) data[urlCol.name] = props.url;

  // 1. Map columns to the entity's native fields where the column name makes
  //    the intent clear. These take priority over any enrichment.
  for (const col of enrichCols) {
    const ln = col.name.toLowerCase();
    if (ln.includes("name") && typeof entity.name === "string")
      data[col.name] = entity.name;
    else if (
      (ln.includes("city") ||
        ln.includes("location") ||
        ln.includes("headquarter") ||
        ln.includes("hq")) &&
      typeof entity.location === "string"
    )
      data[col.name] = entity.location;
    else if (
      (ln.includes("industry") || ln.includes("sector")) &&
      typeof entity.industry === "string"
    )
      data[col.name] = entity.industry;
    else if (
      (ln.includes("about") ||
        ln.includes("description") ||
        ln.includes("summary") ||
        ln.includes("overview")) &&
      (typeof entity.about === "string" ||
        typeof props.description === "string")
    )
      data[col.name] =
        (entity.about as string) || (props.description as string);
  }

  // 2. Fill any column still empty from its enrichment result. Enrichment
  //    results are string[] | null (null when nothing was found).
  for (const e of item.enrichments ?? []) {
    const name = enrichIdToName[e.enrichmentId];
    if (!name) continue;
    if (data[name] !== undefined && data[name] !== "") continue;
    const val = Array.isArray(e.result)
      ? e.result.filter(Boolean).join(", ")
      : "";
    if (val) data[name] = val;
  }

  return data;
}

function itemSources(item: WebsetItem): string[] {
  const urls = new Set<string>();
  if (item.properties?.url) urls.add(item.properties.url);
  for (const ev of item.evaluations ?? [])
    for (const ref of ev.references ?? [])
      if (ref.url) urls.add(ref.url);
  return [...urls];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Build a dataset via an Exa Webset and insert each verified item as a row.
 * Returns the number of rows inserted. Throws on a hard failure (no key, Exa
 * rejects the create, quota exhausted) so the caller marks the run failed.
 */
export async function runWebsetsPopulate(params: {
  datasetId: string;
  datasetName: string;
  description: string;
  columns: PopulateColumn[];
  maxRowCount: number;
  signal?: AbortSignal;
  logger?: Logger;
}): Promise<{ inserted: number }> {
  const { datasetId, description, columns, maxRowCount, signal, logger } =
    params;

  if (!apiKey())
    throw new Error("EXA_API_KEY is not set; cannot use the Exa Websets engine.");

  const urlCol = pickUrlColumn(columns);
  // Every column except the url column becomes an enrichment.
  const enrichCols = columns.filter((c) => c !== urlCol);
  const enrichments = enrichCols.map((c) => ({
    description: c.description?.trim() || `The ${c.name} of the entity.`,
    format: exaFormat(c.type),
  }));

  log(
    logger,
    `creating webset: count=${maxRowCount} enrichments=${enrichments.length} query="${description.slice(0, 80)}"`,
  );

  // 1. Create the webset.
  const createRes = await api("POST", "/websets/", {
    search: { query: description, count: maxRowCount },
    ...(enrichments.length > 0 ? { enrichments } : {}),
  });
  if (!createRes.ok) {
    const body = await createRes.text();
    throw new Error(
      `Exa Websets create failed (HTTP ${createRes.status}): ${body.slice(0, 300)}`,
    );
  }
  const webset = (await createRes.json()) as Webset;
  const websetId = webset.id;

  // Map enrichment ids -> column names. The response enrichments come back in
  // the order we sent them; fall back to description matching if lengths drift.
  const enrichIdToName: Record<string, string> = {};
  const respEnrich = webset.enrichments ?? [];
  if (respEnrich.length === enrichCols.length) {
    respEnrich.forEach((e, i) => {
      enrichIdToName[e.id] = enrichCols[i].name;
    });
  } else {
    for (const e of respEnrich) {
      const col = enrichCols.find(
        (c) =>
          (c.description?.trim() || `The ${c.name} of the entity.`) ===
          e.description,
      );
      if (col) enrichIdToName[e.id] = col.name;
    }
  }

  log(logger, `webset ${websetId} created; waiting for items + enrichments`);

  // 2. Stream rows in as the webset finds and enriches them. We insert each
  // item the moment all of its enrichments have run, so the dataset's row
  // count climbs live during the build (visible progress) instead of jumping
  // from 0 to N at the end. An enrichment that found nothing still appears in
  // item.enrichments (with a null result), so an enrichment-count check tells
  // us an item is fully processed. We finish when we have maxRowCount rows, or
  // the search finished and every found item is inserted, or the webset goes
  // idle, or on timeout / abort.
  const nEnrich = enrichments.length;
  const insertedIds = new Set<string>();
  let inserted = 0;
  const deadline = Date.now() + IDLE_TIMEOUT_MS;
  let status = "running";

  while (Date.now() < deadline && inserted < maxRowCount) {
    if (signal?.aborted) {
      log(logger, "aborted by user; cancelling webset");
      await api("POST", `/websets/${websetId}/cancel`).catch(() => {});
      break;
    }

    const ws = (await (
      await api("GET", `/websets/${websetId}?expand=items`)
    ).json()) as Webset;
    status = ws.status ?? "running";
    const items = ws.items ?? [];
    const searchesDone = (ws.searches ?? []).every(
      (s) => s.status === "completed" || s.status === "canceled",
    );

    let quotaHit = false;
    for (const item of items) {
      if (inserted >= maxRowCount) break;
      if (insertedIds.has(item.id)) continue;
      if ((item.enrichments ?? []).length < nEnrich) continue; // not ready yet
      const data = itemToRow(item, urlCol, enrichCols, enrichIdToName);
      if (Object.keys(data).length === 0) {
        insertedIds.add(item.id);
        continue;
      }
      try {
        await convex.mutation(internal.datasetRows.insert, {
          datasetId,
          data,
          sources: itemSources(item),
          rowSummary: (item.properties?.description ?? "").slice(0, 200),
          howFound: "Exa Websets (search + verify + enrich)",
        });
        insertedIds.add(item.id);
        inserted++;
      } catch (err) {
        insertedIds.add(item.id); // never retry the same item
        const msg = err instanceof Error ? err.message : String(err);
        if (/quota/i.test(msg)) {
          log(logger, `quota exhausted after ${inserted} rows; stopping`);
          quotaHit = true;
          break;
        }
        // Duplicate or per-row validation issue: skip and keep going.
        log(logger, `skipped one item: ${msg.slice(0, 120)}`);
      }
    }

    log(
      logger,
      `status=${status} items=${items.length} inserted=${inserted} searchesDone=${searchesDone}`,
    );

    if (quotaHit || inserted >= maxRowCount || status === "idle") break;
    // Search finished and every found item has been processed: nothing more is
    // coming, so stop even if the webset has not flipped to idle yet.
    if (searchesDone && items.every((it) => insertedIds.has(it.id))) break;
    await sleep(POLL_MS);
  }

  log(logger, `done: inserted ${inserted} rows (webset status=${status})`);
  return { inserted };
}
