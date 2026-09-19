import { env } from "../env.js";

/**
 * Row accuracy scoring via token log-probabilities.
 *
 * The AI SDK's OpenRouter provider parses logprobs but does not forward them
 * into `providerMetadata`, so this calls the OpenRouter chat-completions API
 * directly and reads `choices[0].logprobs.content`.
 *
 * Method: ask a logprobs-capable model to grade the row on a 0-9 scale, then
 * take the expected value over the digit-token distribution (from
 * `top_logprobs`) and scale it to 0-100. The expected value rewards confident,
 * peaked distributions and penalizes the model being torn between a high and
 * a low grade.
 *
 * Never throws: returns undefined when scoring is unavailable (no API key,
 * model/network error, or no logprobs returned) so callers can still insert
 * the row.
 */

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_DIGIT = 9;
const TOP_LOGPROBS = 10;

export interface AccuracyContext {
  datasetName?: string;
  description?: string;
  columns?: Array<{ name: string; type?: string; description?: string }>;
  data: Record<string, unknown>;
  sources?: string[];
}

interface LogprobToken {
  token: string;
  logprob: number;
  top_logprobs?: Array<{ token: string; logprob: number }>;
}

interface OpenRouterChoice {
  message?: { content?: string | null };
  logprobs?: { content?: LogprobToken[] } | null;
}

function digitFromToken(token: string): number | undefined {
  const trimmed = token.trim();
  return /^[0-9]$/.test(trimmed) ? Number(trimmed) : undefined;
}

/**
 * Expected digit (0-9, fractional) from the model's answer distribution.
 * Prefers the logprob distribution of the first digit token generated.
 */
function expectedDigit(choice: OpenRouterChoice | undefined): number | undefined {
  if (!choice) return undefined;

  const content = choice.logprobs?.content;
  const anchor = content?.find((tok) => digitFromToken(tok.token) !== undefined);

  if (anchor) {
    const candidates: Array<{ digit: number; prob: number }> = [];
    for (const entry of [
      { token: anchor.token, logprob: anchor.logprob },
      ...(anchor.top_logprobs ?? []),
    ]) {
      const digit = digitFromToken(entry.token);
      if (digit !== undefined) {
        candidates.push({ digit, prob: Math.exp(entry.logprob) });
      }
    }

    const total = candidates.reduce((sum, c) => sum + c.prob, 0);
    if (total > 0) {
      const expected =
        candidates.reduce((sum, c) => sum + c.prob * c.digit, 0) / total;
      return expected;
    }

    return digitFromToken(anchor.token);
  }

  // Fallback: no digit token found in logprobs — parse the text answer.
  const text = choice.message?.content ?? "";
  const match = text.match(/[0-9]/);
  return match ? Number(match[0]) : undefined;
}

function buildUserPrompt(ctx: AccuracyContext): string {
  const columnsDesc = (ctx.columns ?? [])
    .map(
      (c) =>
        `- ${c.name}${c.type ? ` (${c.type})` : ""}${c.description ? `: ${c.description}` : ""}`,
    )
    .join("\n");

  const sources =
    ctx.sources && ctx.sources.length > 0
      ? ctx.sources.join("\n")
      : "none provided";

  return `Dataset: ${ctx.datasetName ?? "(unnamed)"}
Description: ${ctx.description ?? "(none)"}

Columns:
${columnsDesc || "(none)"}

Row values:
${JSON.stringify(ctx.data, null, 2)}

Source URLs:
${sources}

On a scale of 0 to 9, how accurate and non-fabricated are this row's values?
0 = clearly fabricated or guessed; 9 = real, verifiable data.
Reply with exactly one digit (0-9) and nothing else.`;
}

/**
 * Score one row. Returns a 0-100 value (one decimal), or undefined if
 * scoring could not be performed.
 */
export async function scoreRow(
  ctx: AccuracyContext,
): Promise<number | undefined> {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) return undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: env.ACCURACY_SCORING_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are a strict data-accuracy grader. You judge whether a row's field values are real, verifiable data or fabricated guesses.",
          },
          { role: "user", content: buildUserPrompt(ctx) },
        ],
        max_tokens: 4,
        temperature: 0,
        logprobs: true,
        top_logprobs: TOP_LOGPROBS,
      }),
      signal: controller.signal,
    });

    if (!response.ok) return undefined;

    const json = (await response.json()) as {
      choices?: OpenRouterChoice[];
    };
    const digit = expectedDigit(json.choices?.[0]);
    if (digit === undefined) return undefined;

    const score = Math.round((digit / MAX_DIGIT) * 1000) / 10;
    return Math.max(0, Math.min(100, score));
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}
