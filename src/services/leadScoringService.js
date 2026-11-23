/**
 * @file leadScoringService.js
 * @description KAN-97 — aggregate pass: nạp event → chấm lại các lead đang mở.
 *
 * Luồng `runLeadScoring({ now, loader })`:
 *   1. Nạp event 30 ngày gần nhất + session (để resolve customer).
 *   2. Nạp lead đang mở của các customer vừa có event + các lead score > 0 mà
 *      đã quá 7 ngày không được chấm lại (để decay tự rơi về 0 khi khách im lặng).
 *   3. Với mỗi lead: `scoreLead(lead, events, now)` → so sánh với điểm cũ
 *      → nếu band đổi hoặc điểm trượt > 0 thì `updateOne` + log audit khi band đổi.
 *
 * Idempotent: hàm thuần `scoreLead` quyết định điểm; cron chạy 1 hay 100 lần
 * cho cùng dữ liệu cũng cùng kết quả.
 */

import Lead from '../models/Lead.js';
import InteractionEvent from '../models/interaction-event.model.js';
import VisitorSession from '../models/visitor-session.model.js';
import ActivityLog from '../models/ActivityLog.js';
import { ActivityEventType } from '../constants/appConstants.js';
import { EVENT_WINDOW_MS, SCORABLE_STAGES, DECAY_WEEK_MS } from '../constants/leadScoringConstants.js';
import { scoreLead } from './leadScoringRules.js';

/** Lead có score > 0 mà cron chưa chấm > STALE_SCORE_MS → kéo vào danh sách chấm. */
const STALE_SCORE_MS = DECAY_WEEK_MS;

const idStr = (value) => (value == null ? null : String(value));

/**
 * Nạp dữ liệu cho một lượt chấm. Cho phép inject qua `loader` khi test.
 */
const defaultLoader = async (fromDate) => {
  const events = await InteractionEvent.find({
    occurredAt: { $gte: fromDate },
  }).lean();
  const sessionIds = Array.from(new Set(events.map((e) => idStr(e.sessionId)).filter(Boolean)));
  const sessions = sessionIds.length
    ? await VisitorSession.find({ _id: { $in: sessionIds } }).lean()
    : [];
  return { events, sessions };
};

/**
 * @param {object} [params]
 * @param {Date}   [params.now]
 * @param {Function} [params.loader]  async (fromDate) → { events, sessions }
 * @returns {Promise<{ scored:number, hot:number, warm:number, cold:number, skipped:number }>}
 */
export const runLeadScoring = async ({ now = new Date(), loader = defaultLoader } = {}) => {
  const fromDate = new Date(now.getTime() - EVENT_WINDOW_MS);
  const { events, sessions } = await loader(fromDate);

  // sessionId → customerId
  const sessionToCustomer = new Map();
  sessions.forEach((s) => {
    if (s.customerId) sessionToCustomer.set(idStr(s._id), idStr(s.customerId));
  });

  // Gắn customerId lên từng event; event của session chưa có customer thì bỏ.
  const eventsByCustomer = new Map();
  for (const event of events) {
    let customerId = idStr(event.customerId); // trường hợp trước nạp sẵn (test)
    if (!customerId) customerId = sessionToCustomer.get(idStr(event.sessionId));
    if (!customerId) continue;
    const list = eventsByCustomer.get(customerId) || [];
    list.push(event);
    eventsByCustomer.set(customerId, list);
  }

  const customersWithEvents = Array.from(eventsByCustomer.keys());

  // Tập lead cần chấm: (a) lead của customer có event, (b) lead score>0 chưa chấm > 7 ngày.
  const staleCutoff = new Date(now.getTime() - STALE_SCORE_MS);
  const leadFilter = {
    isActive: true,
    stage: { $in: [...SCORABLE_STAGES] },
    $or: [
      ...(customersWithEvents.length ? [{ customer: { $in: customersWithEvents } }] : []),
      { score: { $gt: 0 }, $or: [{ lastScoredAt: null }, { lastScoredAt: { $lt: staleCutoff } }] },
    ],
  };
  // $or phải có ít nhất 1 clause: nếu không có customer nào thì dùng branch stale.
  const leads = await Lead.find(leadFilter).lean();

  let scored = 0; let hot = 0; let warm = 0; let cold = 0; let skipped = 0;

  for (const lead of leads) {
    const customerId = idStr(lead.customer);
    const relevantEvents = eventsByCustomer.get(customerId) || [];
    const result = scoreLead(lead, relevantEvents, now);

    const previousScore = lead.score ?? 0;
    const previousBand = lead.scoreBand ?? 'COLD';
    const noChange = result.score === previousScore && result.scoreBand === previousBand;

    if (noChange && lead.lastScoredAt) { skipped += 1; continue; }

    await Lead.updateOne({ _id: lead._id }, {
      $set: {
        score: result.score,
        scoreBand: result.scoreBand,
        lastInteractionAt: result.lastInteractionAt || lead.lastInteractionAt || null,
        lastScoredAt: now,
        scoreFactors: result.factors,
      },
    });

    if (result.scoreBand !== previousBand) {
      await ActivityLog.create({
        eventType: ActivityEventType.LEAD_SCORE_UPDATED,
        performedBy: null,
        targetModel: 'Lead',
        targetId: lead._id,
        targetCode: lead.leadCode || null,
        summary: `Lead band ${previousBand} → ${result.scoreBand} (${result.score}đ)`,
        metadata: {
          reason: 'cron',
          previousScore, previousBand,
          score: result.score, scoreBand: result.scoreBand,
          factors: result.factors,
        },
      });
    }

    scored += 1;
    if (result.scoreBand === 'HOT') hot += 1;
    else if (result.scoreBand === 'WARM') warm += 1;
    else cold += 1;
  }

  return { scored, hot, warm, cold, skipped };
};

export default { runLeadScoring };
