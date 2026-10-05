// Provider-agnostic LLM client — every AI-assisted feature in this codebase (site
// classification, visual review, requirement expansion, report dedup/summary/validation,
// agentic exploration, the per-category knowledge base) used to call Google's Gemini API
// directly and hardcode its request/response shape. That meant the whole project only worked
// with a Gemini key; pasting in an OpenAI or Anthropic key failed outright. This is the single
// place that knows how to talk to any of the three — callers just pass a prompt (optionally
// with images) and get text back, regardless of which key is actually configured.
//
// Provider is auto-detected from whichever API key env var is set, checked in this order:
// GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY. If more than one is set, Gemini wins (it
// was the original default); set only the one you want to actually use.
//
// Same hybrid discipline as every caller already follows: never throws, returns null on any
// failure (missing key, timeout, non-2xx response, malformed body) — callers treat null as
// "fall back to the deterministic path," never as something to surface to the user directly.

export type LLMPart = { type: 'text'; text: string } | { type: 'image'; mimeType: string; base64: string };

type Provider = 'gemini' | 'openai' | 'anthropic';

// Fast, inexpensive models — these calls are high-volume, latency-tolerant background QA
// analysis, not a user-facing chat turn, so the cheapest capable tier in each family is the
// right default. A single constant per provider, so bumping the model later is a one-line
// change rather than a hunt through request-building code.
const MODELS: Record<Provider, string> = {
  gemini: 'gemini-3.6-flash',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5-20251001',
};

const DEFAULT_TIMEOUT_MS = 50000;

function detectProvider(): { provider: Provider; apiKey: string } | null {
  if (process.env.GEMINI_API_KEY) return { provider: 'gemini', apiKey: process.env.GEMINI_API_KEY };
  if (process.env.OPENAI_API_KEY) return { provider: 'openai', apiKey: process.env.OPENAI_API_KEY };
  if (process.env.ANTHROPIC_API_KEY) return { provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY };
  return null;
}

/** True when any supported provider's API key is configured — callers use this instead of
 *  checking `process.env.GEMINI_API_KEY` directly, which only ever covered one provider. */
export function hasAnyLLMKey(): boolean {
  return detectProvider() !== null;
}

/** Which provider will actually be used, for logging ("sent to Gemini" vs "sent to OpenAI"). */
export function activeLLMProvider(): Provider | null {
  return detectProvider()?.provider ?? null;
}

async function callGemini(apiKey: string, parts: LLMPart[], signal: AbortSignal): Promise<string | null> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.gemini}:generateContent`;
  const geminiParts = parts.map((p) =>
    p.type === 'text' ? { text: p.text } : { inline_data: { mime_type: p.mimeType, data: p.base64 } },
  );
  const response = await fetch(`${endpoint}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({ contents: [{ parts: geminiParts }] }),
  });
  if (!response.ok) return null;
  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return data.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text ?? null;
}

async function callOpenAI(apiKey: string, parts: LLMPart[], signal: AbortSignal): Promise<string | null> {
  const content = parts.map((p) =>
    p.type === 'text'
      ? { type: 'text', text: p.text }
      : { type: 'image_url', image_url: { url: `data:${p.mimeType};base64,${p.base64}` } },
  );
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    signal,
    body: JSON.stringify({ model: MODELS.openai, messages: [{ role: 'user', content }] }),
  });
  if (!response.ok) return null;
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? null;
}

async function callAnthropic(apiKey: string, parts: LLMPart[], signal: AbortSignal): Promise<string | null> {
  const content = parts.map((p) =>
    p.type === 'text'
      ? { type: 'text', text: p.text }
      : { type: 'image', source: { type: 'base64', media_type: p.mimeType, data: p.base64 } },
  );
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    signal,
    body: JSON.stringify({ model: MODELS.anthropic, max_tokens: 4096, messages: [{ role: 'user', content }] }),
  });
  if (!response.ok) return null;
  const data = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  return data.content?.find((b) => b.type === 'text')?.text ?? null;
}

/** Text + optional images, in order (e.g. [prompt, screenshot1-label, screenshot1,
 *  screenshot2-label, screenshot2]) — the shape visual-review.ts needs for multi-screenshot
 *  review. Plain-text callers use callLLM() below instead. */
export async function callLLMParts(parts: LLMPart[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string | null> {
  const detected = detectProvider();
  if (!detected) return null;
  const { provider, apiKey } = detected;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (provider === 'gemini') return await callGemini(apiKey, parts, controller.signal);
    if (provider === 'openai') return await callOpenAI(apiKey, parts, controller.signal);
    return await callAnthropic(apiKey, parts, controller.signal);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Plain-text prompt, no images — the common case for every caller except visual-review.ts. */
export async function callLLM(prompt: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string | null> {
  return callLLMParts([{ type: 'text', text: prompt }], timeoutMs);
}
