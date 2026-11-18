/**
 * @file chatLlmClient.js
 * @description OpenAI-compatible LLM client for the TrustCar AI Assistant.
 *
 * Uses Hybrid AI grounding:
 * - Only summarizes and converses using the real MongoDB inventory, showroom
 *   settings, and loan configuration passed in `groundedContext`.
 * - Falls back to `null` whenever no API key is configured, the provider times
 *   out, or the payload is invalid — allowing `chatService.js` to serve a
 *   deterministic, data-grounded Vietnamese response with zero downtime.
 */

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 7000;

const SYSTEM_PROMPT = [
  'Bạn là Trợ lý AI chính thức của Showroom xe đã qua sử dụng TrustCar.',
  'Quy tắc bắt buộc:',
  '1. Trả lời bằng tiếng Việt lịch sự, chuyên nghiệp, ngắn gọn (tối đa 4-6 câu hoặc gạch đầu dòng rõ ràng).',
  '2. CHỈ được phép giới thiệu các mẫu xe, giá bán, số ODO, năm sản xuất và mã xe có trong `groundedContext.matchedCars` hoặc `groundedContext.alternativeCars`. Tuyệt đối KHÔNG tự bịa ra mẫu xe, mã xe hay mức giá không có trong dữ liệu.',
  '3. Khi tư vấn trả góp, sử dụng đúng số liệu trong `groundedContext.loanEstimate` và `groundedContext.loanSettings`, đồng thời lưu ý đây là mức ước tính tham khảo.',
  '4. Khi tư vấn địa chỉ, giờ mở cửa, hotline hoặc lịch lái thử, sử dụng đúng thông tin trong `groundedContext.showroom`.',
  '5. Trả về đúng định dạng JSON: {"reply": "<câu trả lời tiếng Việt>", "followUps": ["<gợi ý câu hỏi 1>", "<gợi ý câu hỏi 2>", "<gợi ý câu hỏi 3>"]}. Không thêm markdown code fence.',
].join('\n');

const parseJsonContent = (raw) => {
  if (typeof raw !== 'string') return null;
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
};

/**
 * Generates a grounded conversational response from an OpenAI-compatible chat endpoint.
 *
 * @param {object} params
 * @param {string} params.message - Latest customer message.
 * @param {Array<{role: string, content: string}>} [params.history] - Recent conversation turns.
 * @param {object} params.groundedContext - Real DB context (cars, showroom, loanSettings, intent).
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string} [options.apiKey]
 * @param {string} [options.baseUrl]
 * @param {string} [options.model]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ reply: string, followUps?: string[], provider: string, model: string } | null>}
 */
export const generateGroundedChatCompletion = async (
  { message, history = [], groundedContext = {} },
  options = {}
) => {
  const apiKey =
    options.apiKey ??
    process.env.CHAT_LLM_API_KEY ??
    process.env.CAPTION_LLM_API_KEY;

  if (!apiKey) return null;

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return null;

  const baseUrl = (
    options.baseUrl ||
    process.env.CHAT_LLM_BASE_URL ||
    process.env.CAPTION_LLM_BASE_URL ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, '');

  const model =
    options.model ||
    process.env.CHAT_LLM_MODEL ||
    process.env.CAPTION_LLM_MODEL ||
    (baseUrl.includes('googleapis.com') ? 'gemini-3-flash-preview' : DEFAULT_MODEL);

  const timeoutMs =
    Number(options.timeoutMs ?? process.env.CHAT_LLM_TIMEOUT_MS) ||
    DEFAULT_TIMEOUT_MS;

  const sanitizedHistory = Array.isArray(history)
    ? history
        .filter(
          (item) =>
            item &&
            (item.role === 'user' || item.role === 'assistant') &&
            typeof item.content === 'string' &&
            item.content.trim().length > 0
        )
        .slice(-6)
        .map((item) => ({
          role: item.role,
          content: item.content.trim().slice(0, 600),
        }))
    : [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: 1024,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `${SYSTEM_PROMPT}\n\nDữ liệu thực tế từ hệ thống TrustCar (groundedContext):\n${JSON.stringify(groundedContext)}`,
          },
          ...sanitizedHistory,
          { role: 'user', content: String(message || '').trim() },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    const parsed = parseJsonContent(content);

    if (!parsed || typeof parsed.reply !== 'string' || !parsed.reply.trim()) {
      return null;
    }

    const followUps = Array.isArray(parsed.followUps)
      ? parsed.followUps
          .filter((item) => typeof item === 'string' && item.trim().length > 0)
          .map((item) => item.trim())
          .slice(0, 4)
      : undefined;

    return {
      reply: parsed.reply.trim(),
      followUps,
      provider: baseUrl,
      model,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

export default { generateGroundedChatCompletion };

