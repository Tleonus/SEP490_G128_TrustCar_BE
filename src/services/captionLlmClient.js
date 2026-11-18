/**
 * @file captionLlmClient.js
 * @description Thin HTTP client for the caption model (KAN-68 §6: the key lives in
 * the environment and is never hard-coded).
 *
 * Uses the global `fetch` from Node 22, so no SDK dependency is added. The
 * endpoint is configurable because the team has not committed to one vendor; any
 * OpenAI-compatible chat-completions URL works.
 *
 *   CAPTION_LLM_API_KEY   – required; without it `isConfigured()` is false and the
 *                           caller falls back to templates.
 *   CAPTION_LLM_BASE_URL  – default https://api.openai.com/v1
 *   CAPTION_LLM_MODEL     – default gpt-4o-mini
 *   CAPTION_LLM_TIMEOUT_MS – default 20000
 */

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 20000;

export const isConfigured = () => Boolean(process.env.CAPTION_LLM_API_KEY);

/**
 * Calls the chat-completions endpoint and returns the assistant text.
 *
 * Throws on a network error, a non-2xx response or a missing message. The caller
 * turns any of those into the template fallback, so a model outage never fails
 * the request — it just degrades to the deterministic captions.
 *
 * @param {{ system: string, user: string }} prompt
 * @returns {Promise<string>}
 */
export const complete = async ({ system, user }) => {
  const apiKey = process.env.CAPTION_LLM_API_KEY;
  if (!apiKey) throw new Error('CAPTION_LLM_API_KEY is not set.');

  const baseUrl = (process.env.CAPTION_LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = Number(process.env.CAPTION_LLM_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.CAPTION_LLM_MODEL || DEFAULT_MODEL,
        temperature: 0.8,
        // Ask for JSON directly so the reply needs no prose stripping.
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Caption LLM returned ${response.status}: ${detail.slice(0, 200)}`);
    }

    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content;
    if (!text) throw new Error('Caption LLM returned an empty message.');
    return text;
  } finally {
    clearTimeout(timer);
  }
};

export default { isConfigured, complete };
