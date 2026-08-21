/**
 * Provider-agnostic JSON completion.
 *
 * Anthropic first, OpenAI second, and if neither key is present the caller
 * falls back to heuristic clustering. Kept deliberately thin — one call a day
 * doesn't justify an SDK dependency.
 */

export type LlmResult = { text: string; provider: string };

/**
 * Hard ceiling on the model call.
 *
 * Without this, a provider that accepts the connection and then stalls will
 * consume the function's entire 300s budget and get killed by the platform —
 * no digest, no error, nothing in the run log to explain it. Failing at 120s
 * instead means the heuristic fallback still has time to publish something.
 */
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 120_000);

export function hasLlm(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
}

async function callAnthropic(
  system: string,
  user: string,
  maxTokens: number,
): Promise<LlmResult> {
  const base = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    content: Array<{ type: string; text?: string }>;
  };
  const text = data.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
  return { text, provider: "anthropic" };
}

async function callOpenAI(
  system: string,
  user: string,
  maxTokens: number,
): Promise<LlmResult> {
  const base = process.env.OPENAI_BASE_URL ?? "https://api.openai.com";
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY!}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4o",
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  return { text: data.choices[0]?.message?.content ?? "", provider: "openai" };
}

export async function completeJson(
  system: string,
  user: string,
  maxTokens = 8000,
): Promise<LlmResult> {
  if (process.env.ANTHROPIC_API_KEY) {
    return callAnthropic(system, user, maxTokens);
  }
  if (process.env.OPENAI_API_KEY) {
    return callOpenAI(system, user, maxTokens);
  }
  throw new Error("No LLM provider configured");
}

/** Models sometimes wrap JSON in prose or fences; recover the object. */
export function parseJsonLoose<T>(text: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // fall through
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]) as T;
    } catch {
      // fall through
    }
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1)) as T;
  }

  throw new Error("Could not parse JSON from model output");
}
