/**
 * Working-day calendar behind the peak tariff.
 *
 * Peak price applies on statutory working days, Beijing time 09:00-12:00 and
 * 14:00-18:00. "Working day" is the State Council's calendar, not just
 * Monday-Friday: a weekday the notice turns into a holiday is off-peak all day,
 * and a weekend it turns into a make-up workday still pays peak inside those
 * windows.
 *
 * The dates come from holiday-cn (MIT, https://github.com/NateScarlet/holiday-cn),
 * which scrapes the State Council notice daily and publishes one JSON per year:
 * `{ year, papers, days: [{ name, date, isOffDay }] }`. They are cached under
 * the DSH home, so a restart — or a start without network — keeps the last
 * known calendar. A year that is neither cached, bundled, nor reachable falls
 * back to Monday-Friday, which is what this plugin used before it knew better.
 *
 * `DSH_USAGE_DOCK_CALENDAR=off` disables fetching; `DSH_USAGE_DOCK_CALENDAR_BASE`
 * points the fetch at a mirror (its `<base>/<year>.json` is tried first).
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Community mirrors, tried in order; the first that answers wins. */
const MIRRORS = [
  (year) => `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`,
  (year) => `https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`,
  (year) => `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`,
];

/** A cached year is re-checked after a week; a failed fetch waits an hour. */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 8000;

/** Loaded year -> the two day sets and their fetch bookkeeping. */
const years = new Map();

/** Plugin state directory under the DSH home. */
function cacheDir() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-usage-dock');
}

function cachePath(year) {
  return join(cacheDir(), `calendar-${year}.json`);
}

/** Whether outbound requests are allowed at all. */
function networkAllowed() {
  if (typeof fetch !== 'function') return false;
  const setting = String(process.env.DSH_USAGE_DOCK_CALENDAR || '').toLowerCase();
  return !(setting === 'off' || setting === '0' || setting === 'false' || setting === 'no');
}

/** Mirrors for one year, custom base first. */
function mirrors(year) {
  const list = [];
  const base = String(process.env.DSH_USAGE_DOCK_CALENDAR_BASE || '').replace(/\/+$/, '');
  if (base !== '') list.push(`${base}/${year}.json`);
  return list.concat(MIRRORS.map((build) => build(year)));
}

/** Days of one kind (off or make-up work) out of a payload's `days`. */
function collect(days, offDay) {
  const set = new Set();
  for (const item of days) {
    if (item === null || typeof item !== 'object') continue;
    if (item.isOffDay !== offDay) continue;
    if (typeof item.date === 'string' && item.date !== '') set.add(item.date);
  }
  return set;
}

/** The cached payload of a year, or null when absent or unreadable. */
function readCache(year) {
  try {
    const file = cachePath(year);
    const body = JSON.parse(readFileSync(file, 'utf8'));
    if (body === null || !Array.isArray(body.days)) return null;
    return { off: collect(body.days, true), work: collect(body.days, false), at: statSync(file).mtimeMs };
  } catch {
    return null;
  }
}

/** A snapshot shipped beside this module, so a first start offline still works. */
function readBundled(year) {
  try {
    const body = JSON.parse(readFileSync(new URL(`./calendar-${year}.json`, import.meta.url), 'utf8'));
    if (body === null || !Array.isArray(body.days)) return null;
    return { off: collect(body.days, true), work: collect(body.days, false) };
  } catch {
    return null;
  }
}

/** Write one year's payload where the next start will find it. */
function writeCache(year, body) {
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(cachePath(year), JSON.stringify(body), 'utf8');
  } catch {
    /* the cache is an optimisation: pricing still works without it */
  }
}

/** Fetch one URL with a timeout; null on any failure or unexpected shape. */
async function readRemote(url) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller === null ? null : setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller === null ? undefined : controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body !== null && typeof body === 'object' && Array.isArray(body.days) ? body : null;
  } catch {
    return null;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** Refresh one year in the background; never throws, never blocks a request. */
function refresh(year) {
  const entry = years.get(year);
  if (entry === undefined || entry.fetching || !networkAllowed()) return;
  if (entry.retryAt > Date.now()) return;
  entry.fetching = true;
  void (async () => {
    try {
      for (const url of mirrors(year)) {
        const body = await readRemote(url);
        if (body === null) continue;
        entry.off = collect(body.days, true);
        entry.work = collect(body.days, false);
        entry.at = Date.now();
        entry.retryAt = 0;
        entry.source = 'remote';
        writeCache(year, body);
        return;
      }
      entry.retryAt = Date.now() + RETRY_MS;
    } finally {
      entry.fetching = false;
    }
  })().catch(() => {
    /* a failed refresh keeps whatever the cache or the snapshot already had */
  });
}

/** The in-memory entry of a year, loading the cache and scheduling a refresh. */
function stateFor(year) {
  let entry = years.get(year);
  if (entry === undefined) {
    entry = { off: new Set(), work: new Set(), at: 0, retryAt: 0, fetching: false, source: 'none' };
    const cached = readCache(year);
    if (cached !== null) {
      entry.off = cached.off;
      entry.work = cached.work;
      entry.at = cached.at;
      entry.source = 'cache';
    } else {
      const bundled = readBundled(year);
      if (bundled !== null) {
        entry.off = bundled.off;
        entry.work = bundled.work;
        entry.source = 'bundled';
      }
    }
    years.set(year, entry);
  }
  const now = Date.now();
  if (!entry.fetching && entry.retryAt <= now && now - entry.at > CACHE_TTL_MS) refresh(year);
  return entry;
}

/** `YYYY-MM-DD` of a Beijing-time instant. */
function dateKey(bj) {
  const month = String(bj.getUTCMonth() + 1).padStart(2, '0');
  const day = String(bj.getUTCDate()).padStart(2, '0');
  return `${bj.getUTCFullYear()}-${month}-${day}`;
}

/** The two peak windows of a working day, in hours after midnight. */
function inPeakWindow(hour) {
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

/**
 * Peak price at one instant.
 * @param {number} [ts] epoch milliseconds; defaults to now.
 * @returns {boolean} true inside a peak window of a working day.
 */
export function peakAt(ts) {
  const time = ts === undefined ? Date.now() : ts;
  if (typeof time !== 'number' || !Number.isFinite(time)) return false;
  const bj = new Date(time + 8 * 3600e3);
  const daytime = bj.getUTCHours() + bj.getUTCMinutes() / 60;
  const key = dateKey(bj);
  const entry = stateFor(bj.getUTCFullYear());
  if (entry.work.has(key)) return inPeakWindow(daytime);
  if (entry.off.has(key)) return false;
  const weekday = bj.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  return inPeakWindow(daytime);
}

/** Peak price right now; what the pill's estimate is allowed to assume. */
export function nowPeak() {
  return peakAt(Date.now());
}

/** Warm the calendar around now, so the first request already sees it. */
export function warm() {
  const year = new Date(Date.now() + 8 * 3600e3).getUTCFullYear();
  /* Only the past and current year: next year's notice is often unpublished,
     and the first event of that year loads it lazily anyway. */
  for (let offset = -1; offset <= 0; offset += 1) stateFor(year + offset);
}

/**
 * One-line state of the current year, for the route's diagnostic line:
 * `<year>:<source>:<off>off+<work>work`, where source is cache, bundled,
 * remote, none (weekday-only) or unloaded.
 */
export function describe() {
  const year = new Date(Date.now() + 8 * 3600e3).getUTCFullYear();
  const entry = years.get(year);
  if (entry === undefined) return `${year}:unloaded`;
  return `${year}:${entry.source}:${entry.off.size}off+${entry.work.size}work`;
}
