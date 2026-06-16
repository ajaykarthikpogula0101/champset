// Shared text post-processing for web providers. Keeps the SearXNG and Exa
// providers returning identically-shaped, length-capped page text so the
// agents behave the same regardless of which engine is active.

const MAX_CHARS = 15000;

export function finalizeText(
  title: string | undefined,
  text: string,
): { title?: string; text: string } {
  const cleaned = text.replace(/\n{3,}/g, "\n\n").trim();
  const out =
    cleaned.length > MAX_CHARS
      ? cleaned.slice(0, MAX_CHARS) +
        `\n\n[Truncated - showing first ${MAX_CHARS} of ${cleaned.length} chars]`
      : cleaned;
  return { title, text: out };
}

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export const FETCH_TIMEOUT_MS = 30_000;
