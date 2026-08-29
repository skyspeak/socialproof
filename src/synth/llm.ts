/**
 * Provider-agnostic JSON completion.
 *
 * Gemini and OpenRouter are first-class. Anthropic and OpenAI remain available.
 * If `LLM_PROVIDER` is unset, configured keys are tried in this order:
 * gemini → openrouter → anthropic → openai. A failed hop continues to the
 * next key rather than dropping straight to heuristics.
 *
 * Still no SDK — one call a day does not justify the dependency.
 */

export type LlmResult = { text: string; provider: string };

export type ProviderId = "gemini" | "openrouter" | "anthropic" | "openai";

const ALL_PROVIDERS: ProviderId[] = [
  "gemini",
  "openrouter",
  "anthropic",
  "openai",
];

/**
 * Hard ceiling on the model call.
 *
 * Without this, a provider that accepts the connection and then stalls will
 * consume the function's entire 300s budget and get killed by the platform —
 * no digest, no error, nothing in the run log to explain it. Failing at 120s
 * instead means the heuristic fallback still has time to publish something.
 */
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 120_000);

function geminiKey(): string | undefined {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || undefined;
}

export function configuredProviders(): ProviderId[] {
  const present = new Set<ProviderId>();
  if (geminiKey()) present.add("gemini");
  if (process.env.OPENROUTER_API_KEY) present.add("openrouter");
  if (process.env.ANTHROPIC_API_KEY) present.add("anthropic");
  if (process.env.OPENAI_API_KEY) present.add("openai");

  const pin = process.env.LLM_PROVIDER?.trim();
  if (pin) {
    const wanted = pin
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s): s is ProviderId => (ALL_PROVIDERS as string[]).includes(s));
    return wanted.filter((id) => present.has(id));
  }

  return ALL_PROVIDERS.filter((id) => present.has(id));
}

export function hasLlm(): boolean {
  return configuredProviders().length > 0;
}

async function callGemini(
  system: string,
  user: string,
  maxTokens: number,
): Promise<LlmResult> {
  const key = geminiKey();
  if (!key) throw new Error("GEMINI_API_KEY is not set");

  const model = process.env.GEMINI_MODEL || "gemini-2.5-pro";
  const base = (
    process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta"
  ).replace(/\/$/, "");
  const url = `${base}/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        responseMimeType: "application/json",
        temperature: 0.3,
      },
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    promptFeedback?: { blockReason?: string };
    candidates?: Array<{
      finishReason?: string;
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };

  if (data.promptFeedback?.blockReason) {
    throw new Error(`Gemini blocked the prompt: ${data.promptFeedback.blockReason}`);
  }

  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("");
  if (!text.trim()) {
    throw new Error(
      `Gemini returned empty text (finishReason=${data.candidates?.[0]?.finishReason ?? "none"})`,
    );
  }
  return { text, provider: "gemini" };
}

async function callOpenAiCompatible(opts: {
  provider: "openai" | "openrouter";
  url: string;
  key: string;
  model: string;
  headers?: Record<string, string>;
  system: string;
  user: string;
  maxTokens: number;
}): Promise<LlmResult> {
  const res = await fetch(opts.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.key}`,
      ...opts.headers,
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(
      `${opts.provider} ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }

  const data = (await res.json()) as {
    choices: Array<{ message?: { content?: string | null } }>;
  };
  return {
    text: data.choices[0]?.message?.content ?? "",
    provider: opts.provider,
  };
}

async function callOpenRouter(
  system: string,
  user: string,
  maxTokens: number,
): Promise<LlmResult> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");

  const site = process.env.NEXT_PUBLIC_SITE_URL || "https://trendwire.local";
  const base = (
    process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"
  ).replace(/\/$/, "");
  return callOpenAiCompatible({
    provider: "openrouter",
    url: `${base}/chat/completions`,
    key,
    model: process.env.OPENROUTER_MODEL || "google/gemini-2.5-pro",
    headers: {
      "HTTP-Referer": site,
      "X-Title": "Trendwire",
    },
    system,
    user,
    maxTokens,
  });
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
  const base = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com").replace(
    /\/$/,
    "",
  );
  return callOpenAiCompatible({
    provider: "openai",
    url: `${base}/v1/chat/completions`,
    key: process.env.OPENAI_API_KEY!,
    model: process.env.OPENAI_MODEL || "gpt-4o",
    system,
    user,
    maxTokens,
  });
}

async function dispatch(
  id: ProviderId,
  system: string,
  user: string,
  maxTokens: number,
): Promise<LlmResult> {
  switch (id) {
    case "gemini":
      return callGemini(system, user, maxTokens);
    case "openrouter":
      return callOpenRouter(system, user, maxTokens);
    case "anthropic":
      return callAnthropic(system, user, maxTokens);
    case "openai":
      return callOpenAI(system, user, maxTokens);
  }
}

export async function completeJson(
  system: string,
  user: string,
  maxTokens = 8000,
): Promise<LlmResult> {
  const providers = configuredProviders();
  if (providers.length === 0) {
    throw new Error(
      "No LLM provider configured. Set GEMINI_API_KEY, OPENROUTER_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY.",
    );
  }

  const errors: string[] = [];
  for (const id of providers) {
    try {
      return await dispatch(id, system, user, maxTokens);
    } catch (err) {
      errors.push(
        `${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  throw new Error(`All LLM providers failed. ${errors.join(" | ")}`);
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
