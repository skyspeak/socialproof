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
  return cleanEnv(process.env.GEMINI_API_KEY) || cleanEnv(process.env.GOOGLE_API_KEY);
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

/**
 * Env values pasted into a dashboard arrive with more than the value: wrapping
 * quotes copied from a .env file, trailing whitespace or a newline. The Gemini
 * model name is interpolated into a URL *path*, so any of those turns
 * `models/gemini-2.5-pro:generateContent` into a path Google rejects with
 * `400 GenerateContentRequest.model: unexpected model name format` — which
 * took every issue since the first deploy down to the wire fallback.
 */
export function cleanEnv(raw: string | undefined): string | undefined {
  if (raw == null) return undefined;
  const v = raw.trim().replace(/^(["'])(.*)\1$/s, "$2").trim();
  return v || undefined;
}

/** A model id we can safely put in a URL path, or the fallback. */
/**
 * Google's model families. A value that merely uses legal characters is not
 * enough: an API key pasted into the model field ("AQ.Ab8R…") is all legal
 * characters, and sailed through the first version of this check.
 */
function looksLikeModelId(v: string | undefined): boolean {
  return !!v && /^(gemini|gemma|learnlm)[A-Za-z0-9._-]*$/i.test(v);
}

export function modelName(raw: string | undefined, fallback: string): string {
  const v = cleanEnv(raw)?.replace(/^models\//, "");
  if (v && looksLikeModelId(v)) return v;
  // Never log the value: when it is not a model id it may well be a secret.
  if (v) console.warn(`Ignoring GEMINI_MODEL (${v.length} chars, not a model id); using ${fallback}`);
  return fallback;
}

const GEMINI_FALLBACK_MODELS = ["gemini-2.5-pro", "gemini-2.5-flash"];

function geminiBase(): string {
  const raw = cleanEnv(process.env.GEMINI_BASE_URL);
  return (raw ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
}

/** The configured model, then the known-good ones, without repeats. */
function geminiModelLadder(): string[] {
  const configured = modelName(process.env.GEMINI_MODEL, GEMINI_FALLBACK_MODELS[0]);
  return [configured, ...GEMINI_FALLBACK_MODELS.filter((m) => m !== configured)];
}

/**
 * What the deployed code will actually send to Gemini, for /api/status.
 *
 * The stored variables are write-only in the Vercel dashboard, so when a
 * request is rejected there is otherwise no way to see what the app read. A
 * model id and a base URL are not secrets. The key is reported only by shape —
 * length and prefix — enough to tell a real AI Studio key from a pasted-wrong
 * one without revealing it.
 */
export function geminiConfigSummary() {
  const key = geminiKey();
  const rawModel = process.env.GEMINI_MODEL;
  return {
    // Shape only. The first version of this echoed the raw variable, which is
    // how a pasted API key in the model field was printed on a public page.
    modelEnv:
      rawModel == null
        ? "unset"
        : looksLikeModelId(cleanEnv(rawModel)?.replace(/^models\//, ""))
          ? "valid model id"
          : `ignored: not a model id (${String(rawModel).length} chars)`,
    modelLadder: geminiModelLadder(),
    baseUrl: geminiBase(),
    key: key ? { present: true, length: key.length } : { present: false },
  };
}

async function callGemini(
  system: string,
  user: string,
  maxTokens: number,
): Promise<LlmResult> {
  const key = geminiKey();
  if (!key) throw new Error("GEMINI_API_KEY is not set");

  const base = geminiBase();
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: {
      maxOutputTokens: maxTokens,
      responseMimeType: "application/json",
      temperature: 0.3,
    },
  });

  // The configured model first, then known-good ids. A 400 that says the model
  // name is malformed (or a 404 that says it does not exist) is a property of
  // the *name*, so trying the next one is right; every other failure — a bad
  // key, quota, a blocked prompt — would fail identically, so it stops here.
  // Each attempt is recorded in the error so a failed press run says what was
  // tried, not just that it failed.
  const attempts = geminiModelLadder();
  const tried: string[] = [];
  let res: Response | null = null;
  for (const model of attempts) {
    const url = `${base}/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    if (res.ok) break;
    const detail = (await res.text()).replace(/\s+/g, " ").slice(0, 260);
    tried.push(`${model} → ${res.status} ${detail}`);
    const nameProblem =
      (res.status === 400 && /model name format|model.*invalid/i.test(detail)) ||
      res.status === 404;
    if (!nameProblem) break;
    res = null;
  }
  if (!res || !res.ok) {
    throw new Error(`Gemini failed. Tried: ${tried.join(" | ")}`);
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
  const key = cleanEnv(process.env.OPENROUTER_API_KEY);
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");

  const site = process.env.NEXT_PUBLIC_SITE_URL || "https://trendwire.local";
  const base = (
    process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"
  ).replace(/\/$/, "");
  return callOpenAiCompatible({
    provider: "openrouter",
    url: `${base}/chat/completions`,
    key,
    model: cleanEnv(process.env.OPENROUTER_MODEL) || "google/gemini-2.5-pro",
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
      "x-api-key": cleanEnv(process.env.ANTHROPIC_API_KEY)!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: cleanEnv(process.env.ANTHROPIC_MODEL) || "claude-sonnet-4-5",
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
    key: cleanEnv(process.env.OPENAI_API_KEY)!,
    model: cleanEnv(process.env.OPENAI_MODEL) || "gpt-4o",
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
