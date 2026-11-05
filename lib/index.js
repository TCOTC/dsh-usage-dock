/**
 * dsh-usage-dock — host half.
 *
 * The client pill needs one number the client cannot compute: the session's
 * cost with every assistant step priced at the tariff window in force when that
 * step was actually billed. The aggregate `tokenUsage` projection carries four
 * counters and no timestamps, so a purely client-side figure can only apply one
 * tariff to the whole session — which overcharges a session that ran off-peak
 * but is read during the day, and halves one that ran at peak but is read at
 * night.
 *
 * This half reads the live session's event log instead and answers the pill
 * over one read-only route. Pricing stays local; the only network use is the
 * statutory working-day calendar (holiday-cn), cached beside it — see
 * `calendar.js`.
 */

import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe as describeCalendar, nowPeak, peakAt, warm } from './calendar.js';

/** DeepSeek CNY price card per 1M tokens, peak rates. Off-peak is exactly half. */
const PRICES = {
  flash: { miss: 2, hit: 0.04, out: 8 },
  pro: { miss: 9, hit: 0.3, out: 27 },
};

const COST_PATH = '/plugins/dsh-usage-dock/cost';

/** Ceiling on log events inspected per request, so a huge log cannot stall the loop. */
const MAX_EVENTS = 400000;

/**
 * TEMPORARY diagnostic sink. This host keeps no readable plugin log, so
 * activation and request outcomes are appended here while the route is being
 * brought up. Remove once the route is confirmed on this machine.
 */
function probe(line) {
  try {
    appendFileSync(join(tmpdir(), 'dsh-usage-dock-host.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* diagnostics must never break the plugin */
  }
}

export const name = 'dsh-usage-dock';

/** Only the web server is a hard requirement; the session store is read lazily. */
export const inject = ['webServer'];

/** Price row for a model id; unknown ids fall back to the cheaper flash card. */
function priceRow(model) {
  return String(model || '').toLowerCase().includes('pro') ? PRICES.pro : PRICES.flash;
}

/**
 * One step's usage buckets priced separately, at the peak rate card in CNY.
 * Kept apart so each bucket can then be charged the tariff of its own turn —
 * a session that crossed the peak boundary has no single bucket price.
 * @param usage - one assistant step's usage counters.
 * @param prices - the peak price row in force for that model.
 * @returns the three priced buckets, in CNY at peak rates.
 */
function stepBuckets(usage, prices) {
  return {
    uncached: ((usage.inputTokens || 0) * prices.miss) / 1e6,
    cacheRead: ((usage.cacheReadTokens || 0) * prices.hit) / 1e6,
    output: ((usage.outputTokens || 0) * prices.out) / 1e6,
  };
}

/**
 * Fold a session's assistant steps into one tariff-correct total.
 * @param session - live Session whose log is already in memory.
 * @param model - model id reported by the client, used to pick the price row.
 * @returns the priced breakdown, its peak/off-peak halves, the same buckets
 *   priced per turn, and the event-shape facts needed to debug it.
 */
function breakdown(session, model) {
  const prices = priceRow(model);
  const events = session.snapshotEvents();
  const limit = Math.min(events.length, MAX_EVENTS);
  const types = new Map();
  let peakCost = 0;
  let offCost = 0;
  let steps = 0;
  let peakSteps = 0;
  let first = null;
  let last = null;
  /* Every bucket accumulates the tariff of the turn that incurred it. */
  const buckets = { uncached: 0, cacheRead: 0, output: 0 };
  for (let index = 0; index < limit; index += 1) {
    const event = events[index];
    if (event === null || event === undefined) continue;
    types.set(event.type, (types.get(event.type) || 0) + 1);
    if (event.type !== 'assistant/message') continue;
    const usage = event.data === undefined ? undefined : event.data.usage;
    if (usage === undefined || usage === null) continue;
    const step = stepBuckets(usage, prices);
    const cost = step.uncached + step.cacheRead + step.output;
    if (!(cost > 0)) continue;
    const peak = peakAt(event.time);
    const rate = peak ? 1 : 0.5;
    if (peak) {
      peakCost += cost;
      peakSteps += 1;
    } else {
      offCost += cost / 2;
    }
    buckets.uncached += step.uncached * rate;
    buckets.cacheRead += step.cacheRead * rate;
    buckets.output += step.output * rate;
    steps += 1;
    if (first === null) first = event.time;
    last = event.time;
  }
  return {
    total: peakCost + offCost,
    /* The total split by the window each step was billed in: the pill shows both. */
    peakCost,
    offCost,
    steps,
    peakSteps,
    offSteps: steps - peakSteps,
    /* The same money per bucket, each charged its own turn's tariff. */
    buckets,
    from: first,
    to: last,
    model: model || null,
    events: events.length,
    truncated: events.length > limit,
    types: [...types].sort((a, b) => b[1] - a[1]).slice(0, 6),
  };
}

/** Answer with a JSON body the client can surface verbatim. */
function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

/**
 * Report readiness and mount the read-only cost route.
 * @param ctx - host cordis context.
 */
export function apply(ctx) {
  probe('apply-start');
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: COST_PATH,
          handler: (req, res) => {
            res.setHeader('cache-control', 'no-store');
            if (req.method !== 'GET') {
              sendJson(res, 405, { error: 'method-not-allowed' });
              return;
            }
            const url = new URL(String(req.url || COST_PATH), 'http://127.0.0.1');
            const sessionId = url.searchParams.get('session') || '';
            const model = url.searchParams.get('model') || '';
            if (sessionId === '') {
              probe('request:missing-session');
              sendJson(res, 200, { error: 'missing-session' });
              return;
            }
            /**
             * The Session store is reached through `ctx.get` — the same access
             * other plugins use — because a service is not necessarily a plain
             * property on a plugin context. `ctx.sessions` stays as the older
             * fallback.
             */
            let store = null;
            try {
              store = typeof ctx.get === 'function' ? ctx.get('sessions') : null;
              if (store === null || store === undefined) store = ctx.sessions;
            } catch {
              store = null;
            }
            if (store === null || store === undefined || typeof store.get !== 'function') {
              probe('request:no-sessions-service');
              sendJson(res, 200, { error: 'no-sessions-service' });
              return;
            }
            let session = null;
            try {
              session = store.get(sessionId);
            } catch (error) {
              probe(`request:get-threw ${error instanceof Error ? error.message : String(error)}`);
              sendJson(res, 200, { error: 'session-lookup-threw' });
              return;
            }
            if (session === null || session === undefined) {
              probe(`request:session-not-found ${sessionId}`);
              sendJson(res, 200, { error: 'session-not-found' });
              return;
            }
            let payload = null;
            try {
              payload = breakdown(session, model);
            } catch (error) {
              probe(`request:breakdown-threw ${error instanceof Error ? error.message : String(error)}`);
              sendJson(res, 200, { error: 'breakdown-threw' });
              return;
            }
            probe(
              `request:ok ${sessionId} events=${payload.events} steps=${payload.steps} total=${payload.total.toFixed(4)} peak=${payload.peakCost.toFixed(4)} off=${payload.offCost.toFixed(4)} buckets=${payload.buckets.uncached.toFixed(4)}/${payload.buckets.cacheRead.toFixed(4)}/${payload.buckets.output.toFixed(4)} calendar=${describeCalendar()} types=${JSON.stringify(payload.types)}`,
            );
            if (payload.steps === 0) {
              sendJson(res, 200, { error: 'no-steps', events: payload.events, types: payload.types });
              return;
            }
            /* `nowPeak` lets the pill's estimate agree with this host's calendar. */
            sendJson(res, 200, { ...payload, nowPeak: nowPeak() });
          },
        }),
      `usage-dock: GET ${COST_PATH}`,
    );
    /* Load the working-day calendar now, so the first pill does not wait for it. */
    warm();
    probe('route-registered');
  });
}

/**
 * Pricing internals, so the per-turn bucket maths can be checked without
 * standing up a web server. Not part of the plugin's activation contract.
 */
export const internals = { priceRow, stepBuckets, breakdown };
