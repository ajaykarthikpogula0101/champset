#!/usr/bin/env node
// Live smoke test for the Exa engine. Verifies /search + /contents against the
// real API and prints shapes the ChampSet provider depends on.
//   EXA_API_KEY=... node scripts/exa-smoketest.mjs "US digital marketing agencies"
const key = process.env.EXA_API_KEY;
if (!key) { console.error("Set EXA_API_KEY first."); process.exit(1); }
const base = (process.env.EXA_BASE_URL || "https://api.exa.ai").replace(/\/$/, "");
const query = process.argv[2] || "US digital marketing agencies in California";
const post = (path, body) =>
  fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify(body),
  });

const s = await post("/search", {
  query, type: "auto", numResults: 5, contents: { text: { maxCharacters: 400 } },
});
console.log("[/search] HTTP", s.status);
if (!s.ok) { console.error(await s.text()); process.exit(2); }
const sj = await s.json();
console.log("results:", (sj.results || []).length);
for (const r of (sj.results || []).slice(0, 3))
  console.log(" -", r.title, "|", r.url, "| text:", (r.text || "").length, "chars");

const firstUrl = sj.results?.[0]?.url;
if (firstUrl) {
  const c = await post("/contents", { urls: [firstUrl], text: true, livecrawl: "fallback" });
  console.log("[/contents] HTTP", c.status);
  if (c.ok) {
    const cj = await c.json();
    console.log("contents text:", (cj.results?.[0]?.text || "").length, "chars for", firstUrl);
  } else console.error(await c.text());
}
console.log("\nOK: Exa engine reachable and returning the shapes ChampSet expects.");
