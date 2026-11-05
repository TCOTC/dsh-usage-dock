window.__ModuleLoader__.load({
  id: 'dsh-usage-dock',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var react = require('react');

    /**
     * ReactDOM is how a client half renders into DOM it does not own; the
     * shipped pills do the same for their popovers. Absent, this plugin keeps
     * its own line instead.
     */
    var reactDom = null;
    try {
      reactDom = require('react-dom');
    } catch (error) {
      reactDom = null;
    }

    /**
     * Styles mirror the shipped statistics pills (same tag, padding, radius,
     * gap, colours and 14px icon slot) so the cost reads as one more pill in
     * that row rather than a foreign chip next to it. On a phone the row has
     * three pills to fit, so the icon yields its slot to a plain sign.
     */
    var CSS = [
      '.dshu-host{display:none}',
      '.dshu-wrap{position:relative;display:flex;justify-content:center;align-items:center}',
      '.dshu-slot{position:relative;display:inline-flex;align-items:center;min-width:0;flex:none;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}',
      '.dshu-pill{box-sizing:border-box;max-width:100%;display:inline-flex;align-items:center;gap:6px;padding:1px 8px;border:0;border-radius:var(--dsw-radius-sm,24px);background:0 0;color:var(--dsw-alias-label-tertiary,inherit);font:inherit;line-height:inherit;font-variant-numeric:tabular-nums;font-feature-settings:"tnum";white-space:nowrap;cursor:pointer}',
      '.dshu-pill:hover,.dshu-pill[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));color:var(--dsw-alias-label-secondary,inherit)}',
      '.dshu-icon{flex:none;width:14px;height:14px}',
      '.dshu-sign{display:none}',
      '.dshu-amount{text-overflow:ellipsis;min-width:0;overflow:hidden}',
      '@media (width<=640px){.dshu-icon{display:none}.dshu-sign{display:inline}}',
      '.dshu-panel{position:absolute;bottom:calc(100% + 6px);left:0;z-index:60;min-width:224px;max-width:min(320px,calc(100vw - 24px));padding:8px 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:var(--dsw-alias-bg-layer-3,Canvas);color:var(--dsw-alias-label-primary,CanvasText);box-shadow:0 8px 28px rgba(0,0,0,.28);font-size:12px;line-height:1.5;text-align:left}',
      '.dshu-row{display:flex;justify-content:space-between;gap:18px}',
      '.dshu-row+.dshu-row{margin-top:2px}',
      '.dshu-k{opacity:.66}',
      '.dshu-rate{margin-left:5px;font-size:10px;opacity:.8;white-space:nowrap}',
      '.dshu-total{margin-top:6px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));font-weight:600}',
      '.dshu-hint{margin-top:6px;font-size:10px;opacity:.5}',
      '.dshu-note{grid-column:1/-1;text-align:left;font-size:10px;opacity:.5}'
    ].join('\n');

    /* ------------------------------------------------------------------ *
     * Pricing — DeepSeek official CNY prices per 1M tokens, peak hours.
     * Off-peak is exactly half of peak, so only peak figures are stored.
     * Confirmed against the official statement of 2026-09-12: V4 Pro and
     * V4.1 Flash bill independently (the 09-14 routing plan that would have
     * merged them was cancelled on 09-11), peak = Beijing Mon-Fri 9-12 and
     * 14-18.
     * Override at runtime (applies to every priced model):
     *   localStorage.setItem('dsh-usage-dock.pricing',
     *     JSON.stringify({ miss: 2, hit: 0.04, out: 8, write: 0 }))
     * ------------------------------------------------------------------ */
    var PRICING = {
      flash: { miss: 2, hit: 0.04, out: 8, write: 0 },
      v4pro: { miss: 9, hit: 0.3, out: 27, write: 0 }
    };
    var PRICING_KEY = 'dsh-usage-dock.pricing';

    /**
     * Only this route's tariff is known. Any other provider's tokens would be
     * priced with numbers that do not apply to it, so the pill stays silent
     * instead of confident and wrong.
     */
    /**
     * Local patch: this harness authenticates through the DeepSeek account
     * route, so the `modelSelection` projection reports
     * `provider: 'deepseek-account'`. Keeping only the official-API id would
     * leave the pill permanently silent here. Both routes bill the same
     * DeepSeek CNY rate card.
     */
    var PRICED_PROVIDERS = ['deepseek-official', 'deepseek-account'];

    /** Peak price row for a model id; unknown ids fall back to flash. */
    function resolvePricing(modelId) {
      var custom = null;
      try {
        if (typeof localStorage !== 'undefined') {
          custom = JSON.parse(localStorage.getItem(PRICING_KEY) || 'null');
        }
      } catch {
        /* malformed override falls back to built-in prices */
      }
      if (custom && Number.isFinite(custom.miss)) {
        return { miss: custom.miss, hit: custom.hit || 0, out: custom.out || 0, write: custom.write || 0, custom: true };
      }
      var id = String(modelId || '').toLowerCase();
      var row = id.indexOf('pro') >= 0 ? PRICING.v4pro : PRICING.flash;
      return { miss: row.miss, hit: row.hit, out: row.out, write: row.write, custom: false };
    }

    /** CNY cost of the four billing buckets at peak prices. */
    function costCNY(b, p) {
      return (
        (b.uncachedInputTokens * p.miss +
          b.cacheReadTokens * p.hit +
          b.cacheWriteTokens * p.write +
          b.outputTokens * p.out) /
        1e6
      );
    }

    /**
     * What each of the three priced buckets costs at one tariff, in CNY.
     * `scale` is the tariff multiplier: 1 at peak prices, 0.5 off-peak. The
     * panel only falls back on this before the host's per-turn answer lands;
     * afterwards the host's own bucket figures replace it.
     */
    function bucketCosts(b, p, scale) {
      return [
        ((b.uncachedInputTokens || 0) * p.miss / 1e6) * scale,
        ((b.cacheReadTokens || 0) * p.hit / 1e6) * scale,
        ((b.outputTokens || 0) * p.out / 1e6) * scale
      ];
    }

    /**
     * Local approximation of the peak window: Beijing-time Monday-Friday
     * 09:00-12:00 and 14:00-18:00. The host owns the real answer — its calendar
     * also knows statutory holidays and make-up workdays — and reports it as
     * `nowPeak`; this copy covers only the moment before that answer lands or
     * the case where the route is unavailable.
     */
    function isPeakNow(ts) {
      var bj = new Date((ts === undefined ? Date.now() : ts) + 8 * 3600e3);
      var day = bj.getUTCDay();
      var h = bj.getUTCHours() + bj.getUTCMinutes() / 60;
      if (day === 0 || day === 6) return false;
      return (h >= 9 && h < 12) || (h >= 14 && h < 18);
    }

    /**
     * How long the client keeps asking a host that has not attached the
     * session yet. Right after a restart the store answers "not found" for the
     * session on screen until its Agent attaches it, then the log appears — a
     * transient state, not a failure to give up on.
     */
    var COST_RETRY_LIMIT = 8;
    var COST_RETRY_BASE_MS = 1200;
    var COST_RETRY_MAX_MS = 10000;
    var COST_RETRY_ANSWERS = ['session-not-found', 'no-steps', 'no-sessions-service', 'session-lookup-threw'];

    /** Whether the host's answer means "ask again shortly" rather than "never". */
    function costAnswerRetryable(body) {
      var error = body !== null && typeof body === 'object' && typeof body.error === 'string' ? body.error : '';
      if (error === '') return true;
      if (error.indexOf('http-5') === 0) return true;
      return COST_RETRY_ANSWERS.indexOf(error) !== -1;
    }

    /** Backoff between cost requests: 1.2s, 2.4s, 4.8s, then capped at 10s. */
    function costRetryDelay(attempt) {
      return Math.min(COST_RETRY_MAX_MS, COST_RETRY_BASE_MS * Math.pow(2, attempt - 1));
    }

    /** Insert the pill stylesheet once per document. */
    function ensureStyle() {
      if (document.head.querySelector('style[data-dsh-usage-dock]') !== null) return;
      var el = document.createElement('style');
      el.setAttribute('data-dsh-usage-dock', 'true');
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    /**
     * Cache-hit share of prompt-side billed input. Mirrors the shipped
     * statistics pill: integer percent while rounding stays under 100, one
     * decimal when integer rounding would claim a full hit that is not one.
     */
    function hitText(cacheRead, promptSide) {
      if (promptSide <= 0 || cacheRead <= 0) return null;
      if (cacheRead >= promptSide) return '100%';
      var pct = (cacheRead / promptSide) * 100;
      var rounded = Math.round(pct);
      if (rounded < 100) return rounded + '%';
      // Widen precision until the shown figure is honestly below 100%.
      for (var d = 1; d <= 6; d += 1) {
        var text = pct.toFixed(d);
        if (parseFloat(text) < 100) return text + '%';
      }
      return '99.9999%';
    }

    /** The browser speaks Chinese: drives the copy table below. */
    function isZh() {
      try {
        return /^zh/i.test((navigator && navigator.language) || '');
      } catch {
        /* navigator unavailable */
        return false;
      }
    }

    /**
     * Caption of the exact per-step figure. That total is priced step by step,
     * so the caption carries the split it is made of — full rate during peak
     * hours, half rate for the rest — instead of naming the rule that produced
     * it. A session that never crossed the window boundary has nothing to
     * split, so only the tariff it actually paid is named.
     */
    function zhCostExact(peak, off) {
      var parts = [];
      if (peak > 0) parts.push('峰' + fmtMoney(peak));
      if (off > 0) parts.push('谷' + fmtMoney(off));
      return parts.length === 0 ? '费用' : '费用（' + parts.join('+') + '）';
    }

    /** The same caption in English. */
    function enCostExact(peak, off) {
      var parts = [];
      if (peak > 0) parts.push('peak ' + fmtMoney(peak));
      if (off > 0) parts.push('off-peak ' + fmtMoney(off));
      return parts.length === 0 ? 'Cost' : 'Cost (' + parts.join(' + ') + ')';
    }

    /** Bilingual copy, keyed off the browser language. */
    function labels() {
      var zh = isZh();
      return zh
        ? { total: '本会话 token 累计', uncached: '未缓存输入', cacheRead: '缓存读取', output: '输出', sum: '总计', hit: '缓存命中', costPeak: '费用（高峰价）', costOff: '费用（空闲价）', cost: '费用', costExact: zhCostExact, stepsLabel: '计入轮次', note: '估算：整段会话套当前档位，空闲档为高峰半价', noteExact: '按每轮实际发生时刻计价：北京时区法定工作日 9–12、14–18 为高峰，其余半价', unit: 'tokens', perMillion: '百万tok', more: '费用明细已并入 token 用量卡' }
        : { total: 'Session tokens', uncached: 'Uncached input', cacheRead: 'Cache read', output: 'Output', sum: 'Total', hit: 'Cache hit', costPeak: 'Cost (peak)', costOff: 'Cost (off-peak)', cost: 'Cost', costExact: enCostExact, stepsLabel: 'Steps priced', note: 'Estimate: one tariff for the whole session; off-peak is half of peak', noteExact: 'Priced at each turn’s own time: Beijing statutory working days 9–12 and 14–18 are peak, the rest half price', unit: 'tokens', perMillion: 'M tok', more: 'Cost rows join the token usage card' };
    }

    /**
     * The rate a row was paid at, as the suffix after its label: `¥2/百万tok`.
     * Null when the bucket has no money or no tokens, so a zero row stays bare.
     */
    function rateHint(text, rate) {
      if (rate === null || rate === undefined) return null;
      return rate + '/' + text.perMillion;
    }

    /** Compact token count: 940, 12.3K, 5.19M, 1.20B. */
    function fmt(n) {
      if (!Number.isFinite(n)) return '-';
      var v = Math.round(n);
      if (v < 1000) return String(v);
      if (v < 1e6) return (v / 1e3).toFixed(v < 1e5 ? 1 : 0) + 'K';
      if (v < 1e9) return (v / 1e6).toFixed(v < 1e8 ? 2 : 1) + 'M';
      return (v / 1e9).toFixed(2) + 'B';
    }

    /** CNY amount: widen decimals until the figure is honestly above zero. */
    function fmtMoney(n) {
      if (!Number.isFinite(n)) return '-';
      if (n <= 0) return '¥0';
      for (var d = 2; d <= 6; d += 1) {
        var text = n.toFixed(d);
        if (parseFloat(text) > 0) return '¥' + text;
      }
      return '¥' + n.toFixed(6);
    }

    /** The same amount without the sign: the pill's icon carries the currency. */
    function fmtAmountOnly(n) {
      var text = fmtMoney(n);
      return text.charAt(0) === '\u00A5' ? text.slice(1) : text;
    }

    /** Decimal places `fmtMoney` settles on for an amount. */
    function moneyPlaces(n) {
      if (!Number.isFinite(n) || n <= 0) return 2;
      for (var d = 2; d <= 6; d += 1) {
        if (parseFloat(n.toFixed(d)) > 0) return d;
      }
      return 6;
    }

    /**
     * Round a set of amounts so they add up to the total exactly, at the
     * precision the total itself is shown with. `weights` are the parts' own
     * amounts; the leftover units that rounding leaves behind go to the largest
     * remainders, so the bucket rows never disagree with the total below them.
     * @returns the parts in CNY, already rounded to the shown precision.
     */
    function moneySplit(total, weights) {
      var places = moneyPlaces(total);
      var unit = Math.pow(10, places);
      var sum = 0;
      var i;
      for (i = 0; i < weights.length; i += 1) sum += Math.max(0, Number(weights[i]) || 0);
      var scaled = Math.round(total * unit);
      var parts = [];
      var order = [];
      var used = 0;
      for (i = 0; i < weights.length; i += 1) {
        var exact = sum > 0 ? (scaled * Math.max(0, Number(weights[i]) || 0)) / sum : 0;
        var base = Math.floor(exact);
        parts.push(base);
        used += base;
        order.push({ index: i, rest: exact - base });
      }
      order.sort(function (a, b) {
        return b.rest - a.rest;
      });
      /* Nothing to weight by: the whole amount belongs to the first part. */
      var left = sum > 0 ? scaled - used : 0;
      if (sum <= 0) parts[0] = scaled;
      for (i = 0; i < left && order.length > 0; i += 1) parts[order[i % order.length].index] += 1;
      var out = [];
      for (i = 0; i < parts.length; i += 1) out.push(parts[i] / unit);
      return out;
    }

    /** One split part as CNY, at the width the total beside it is shown with. */
    function moneyText(part, total) {
      return '\u00A5' + part.toFixed(moneyPlaces(total));
    }

    /**
     * The same split before any rounding: `total` handed out in proportion to
     * `weights`. The rows show these through `moneySplit`; the rates beside them
     * are derived from here, so rounding to cents never bends a rate card.
     * @returns one unrounded CNY amount per weight.
     */
    function apportion(total, weights) {
      var sum = 0;
      var i;
      for (i = 0; i < weights.length; i += 1) sum += Math.max(0, Number(weights[i]) || 0);
      var out = [];
      for (i = 0; i < weights.length; i += 1) {
        var weight = Math.max(0, Number(weights[i]) || 0);
        out.push(sum > 0 ? (total * weight) / sum : i === 0 ? total : 0);
      }
      return out;
    }

    /**
     * The price actually paid per million tokens: whatever tariff each turn ran
     * in, folded into the one rate that reproduces this bucket's money. At a
     * single tariff this is the rate card itself.
     * @param money - the bucket's cost in CNY.
     * @param tokens - the bucket's token count.
     * @returns CNY per million tokens, or null when there is nothing to divide.
     */
    function rateOf(money, tokens) {
      if (!(money > 0) || !(tokens > 0)) return null;
      return (money / tokens) * 1e6;
    }

    /** A rate as `¥2` / `¥0.04` / `¥1.53`: at most four decimals, no padding. */
    function fmtRate(rate) {
      if (!Number.isFinite(rate) || rate <= 0) return null;
      var text = rate.toFixed(4).replace(/\.?0+$/, '');
      /* Four decimals would round a hair above nothing down to zero. */
      if (parseFloat(text) <= 0) return '\u00A5<0.0001';
      return '\u00A5' + text;
    }

    /**
     * Sent to `bucketMoney` when the panel's figures are the local estimate
     * rather than a host answer, which is the one case where the rate card
     * itself is the rate paid.
     */
    var ESTIMATE = 'estimate';

    /**
     * The three bucket rows' money, in the order the panel prints them, plus the
     * rate each one was paid at.
     *
     * Each turn is charged the window it actually ran in, so the host prices
     * every bucket itself and its figures are used as they are; the rate is then
     * whatever that money works out to per million tokens. The local estimate
     * applies one tariff to the whole session, so there the rate is the rate card
     * and the split is arithmetic.
     *
     * A host that answers with a total but no buckets leaves the rows sharing a
     * blended total the client cannot attribute, and then no rate is claimed: a
     * rate beside a share would contradict the money beside it.
     * @param total - the money the rows must add up to.
     * @param exactBuckets - the host's `{ uncached, cacheRead, output }`, `ESTIMATE`, or null.
     * @param usage - aggregate token counters, the estimate's input.
     * @param prices - peak price row for the model.
     * @param tariff - 1 while the estimate is priced at peak, 0.5 off-peak.
     * @returns the three amounts in CNY, and the rate each one was paid at.
     */
    function bucketMoney(total, exactBuckets, usage, prices, tariff) {
      var usable =
        exactBuckets !== null &&
        exactBuckets !== undefined &&
        typeof exactBuckets.uncached === 'number' &&
        typeof exactBuckets.cacheRead === 'number' &&
        typeof exactBuckets.output === 'number';
      var estimated = exactBuckets === ESTIMATE;
      var parts = usable ? [exactBuckets.uncached, exactBuckets.cacheRead, exactBuckets.output] : bucketCosts(usage, prices, 1);
      var value = moneySplit(total, parts);
      var tokens = [usage.uncachedInputTokens || 0, usage.cacheReadTokens || 0, usage.outputTokens || 0];
      var card = [prices.miss, prices.hit, prices.out];
      var raw = usable ? apportion(total, parts) : null;
      var rate = [];
      for (var i = 0; i < value.length; i += 1) {
        if (raw !== null) rate.push(fmtRate(rateOf(raw[i], tokens[i])));
        else rate.push(estimated ? fmtRate(card[i] * tariff) : null);
      }
      return { value: value, text: value.map(function (part) { return moneyText(part, total); }), rate: rate };
    }

    /**
     * The Session this dock entry belongs to. `conversation.composer.dock` is a
     * session-scoped slot, so the shell hands the id down in its props; accept
     * the few shapes that could carry it and give up quietly otherwise — the
     * pill then keeps its aggregate estimate instead of guessing.
     */
    function sessionIdOf(props) {
      if (props === null || props === undefined) return null;
      var candidates = [props.sessionId, props.session, props.id];
      for (var i = 0; i < candidates.length; i += 1) {
        if (typeof candidates[i] === 'string' && candidates[i] !== '') return candidates[i];
      }
      return null;
    }

    /**
     * The shipped statistics row: the one place in the dock that already lays
     * pills out with the exact gap and centring this third one wants.
     * Identified by the attribute the shell's own stylesheet keys on.
     */
    function shippedStatsRow(node) {
      if (node === null || node === undefined) return null;
      if (typeof node.hasAttribute !== 'function' || !node.hasAttribute('data-composer-stats')) return null;
      if (node.isConnected === false) return null;
      return node;
    }

    /** The shipped token-usage pill: the row's last dialog-anchored button. */
    function shippedUsagePill(row) {
      if (row === null || row === undefined || typeof row.querySelectorAll !== 'function') return null;
      var buttons = row.querySelectorAll('button[aria-haspopup="dialog"]');
      if (buttons === null || buttons === undefined || buttons.length === 0) return null;
      return buttons[buttons.length - 1];
    }

    /**
     * The shipped token-usage card while it is open. Only one shipped pill
     * holds a dialog at a time (one `openPill` state), so "this row's usage
     * pill is expanded" identifies the dialog it owns.
     */
    function openUsageDialog(row) {
      var pill = shippedUsagePill(row);
      if (pill === null || typeof pill.getAttribute !== 'function' || pill.getAttribute('aria-expanded') !== 'true') return null;
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null;
      var dialogs = document.querySelectorAll('div[role="dialog"]');
      if (dialogs === null || dialogs === undefined) return null;
      for (var i = dialogs.length - 1; i >= 0; i -= 1) {
        var dialog = dialogs[i];
        var dl = dialog !== null && typeof dialog.querySelector === 'function' ? dialog.querySelector('dl') : null;
        if (dl !== null && dl !== undefined) return dl;
      }
      return null;
    }

    /** One marked row node, created on first use and reused after that. */
    function costRowNode(dl, key, tag) {
      var node = typeof dl.querySelector === 'function' ? dl.querySelector('[data-dsh-usage-dock="' + key + '"]') : null;
      if (node !== null && node !== undefined) return node;
      node = document.createElement(tag);
      node.setAttribute('data-dsh-usage-dock', key);
      dl.appendChild(node);
      return node;
    }

    /**
     * Whether the aggregate estimate is priced at the peak tariff right now:
     * the host's calendar answer when it has one, otherwise the local
     * approximation. One reader for every surface, so the pill, the panel and
     * its bucket rows cannot land on different tariffs.
     */
    function peakNow(view) {
      if (view.nowPeak === null || view.nowPeak === undefined) return isPeakNow();
      return view.nowPeak === true;
    }

    /**
     * The one figure every surface shows for this session: the per-turn exact
     * cost when the host answered, otherwise the estimate at the tariff window
     * in force right now. Two prices never sit side by side — the reader wants
     * one number, not a menu. A session that paid both tariffs carries both
     * amounts in that one caption. The window comes from the host's calendar
     * when it reported one, and is otherwise approximated locally.
     */
    function costLine(view) {
      var text = view.text;
      if (view.exactCost !== null) {
        return {
          label: view.exactPeak === null || view.exactOff === null ? text.cost : text.costExact(view.exactPeak, view.exactOff),
          amount: fmtMoney(view.exactCost),
          value: view.exactCost,
          exact: true,
          note: text.noteExact
        };
      }
      var peak = peakNow(view);
      var value = peak ? view.peakCost : view.offCost;
      return {
        label: peak ? text.costPeak : text.costOff,
        amount: fmtMoney(value),
        value: value,
        exact: false,
        note: text.note
      };
    }

    /** Remove marked rows written by an earlier build, so none lingers. */
    function dropRowNodes(dl, keys) {
      if (dl === null || dl === undefined || typeof dl.querySelector !== 'function') return;
      for (var i = 0; i < keys.length; i += 1) {
        var node = dl.querySelector('[data-dsh-usage-dock="' + keys[i] + '"]');
        if (node !== null && node !== undefined && typeof node.remove === 'function') node.remove();
      }
    }

    /**
     * Put the cost row (and its note) into the shipped token-usage card. That
     * card's rows are `dt`/`dd` pairs styled by element selectors under its own
     * `dl`, so an appended pair inherits exactly the shipped look — no class
     * names of ours to keep in sync with upstream. Idempotent: re-running
     * updates the row in place. The card's own rows are the shell's and stay as
     * they are.
     */
    function syncCostRows(dl, view) {
      var line = costLine(view);
      costRowNode(dl, 'cost-label', 'dt').textContent = line.label;
      costRowNode(dl, 'cost-value', 'dd').textContent = line.amount;
      var note = costRowNode(dl, 'note', 'dd');
      note.className = 'dshu-note';
      note.textContent = line.note;
      dropRowNodes(dl, ['peak-label', 'peak-value', 'off-label', 'off-value']);
    }

    /**
     * Row of the fallback panel: a label, the money it cost, and — when the
     * bucket has one — the rate that money was paid at.
     */
    function row(label, value, key, cls, hint) {
      return react.createElement(
        'div',
        { className: cls ? 'dshu-row ' + cls : 'dshu-row', key: key },
        react.createElement(
          'span',
          { className: 'dshu-k' },
          label,
          hint === null || hint === undefined ? null : react.createElement('span', { className: 'dshu-rate' }, hint)
        ),
        react.createElement('span', { className: 'dshu-num' }, value)
      );
    }

    /**
     * 14px currency mark drawn in the shipped icon grammar — 16-unit box,
     * 1px stroke declared on the svg, butt caps, geometry inside 2–14.
     *
     * The coin is Tabler's `coin-yuan` (MIT), re-scaled from its native 24-unit
     * grid and optically re-tuned for a 14px rasterisation: the source puts the
     * bar 0.5 units under the arm junction, which collapses to a ~0.3px knot at
     * this size, so the bar sits 1.1 units lower and runs 0.4 wider.
     */
    function moneyIcon() {
      return react.createElement(
        'svg',
        {
          className: 'dshu-icon',
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          strokeWidth: 1,
          'aria-hidden': true,
          focusable: false
        },
        react.createElement('circle', { cx: 8, cy: 8, r: 6, stroke: 'currentColor' }),
        react.createElement('path', { d: 'M5.8 4.8 8 7.8', stroke: 'currentColor' }),
        react.createElement('path', { d: 'M10.2 4.8 8 7.8V11.3', stroke: 'currentColor' }),
        react.createElement('path', { d: 'M5.8 8.9h4.4', stroke: 'currentColor' })
      );
    }

    /**
     * Composer-dock occupant: the session's estimated CNY cost from the
     * durable `tokenUsage` projection, drawn as one more pill in the shipped
     * statistics row.
     *
     * Two surfaces show the same money. When the shipped statistics row can be
     * found, the detail rows join the shipped token-usage card and merely name
     * the total — that card already lists the token buckets, so the cost sits
     * beside them. Otherwise the pill opens its own panel, and there the money
     * replaces the token counts outright: each row is what that bucket cost,
     * and the rows add up to the total they sit under.
     */
    function UsageCostPill(props) {
      var useProjection = props && props.useProjection;
      var usage = typeof useProjection === 'function' ? useProjection('tokenUsage') : undefined;
      var modelSel = typeof useProjection === 'function' ? useProjection('modelSelection') : undefined;
      var openPair = react.useState(false);
      var open = openPair[0];
      var setOpen = openPair[1];
      /**
       * Per-step pricing from the host half: `{ total, steps, peakSteps, ... }`.
       * Null until it lands, and null forever when the id is unknown or the
       * request fails, in which case the pill falls back to the aggregate
       * estimate the projection alone can support.
       */
      var exactPair = react.useState(null);
      var exact = exactPair[0];
      var setExact = exactPair[1];
      var exactRef = react.useRef(null);
      var rowPair = react.useState(null);
      var portalRow = rowPair[0];
      var setPortalRow = rowPair[1];
      var hostRef = react.useRef(null);
      var panelRef = react.useRef(null);
      var syncRef = react.useRef(null);

      react.useEffect(function () {
        if (!open) return undefined;
        function onDown(event) {
          if (hostRef.current !== null && !hostRef.current.contains(event.target)) setOpen(false);
        }
        function onKey(event) {
          if (event.key === 'Escape') setOpen(false);
        }
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        return function () {
          document.removeEventListener('pointerdown', onDown, true);
          document.removeEventListener('keydown', onKey, true);
        };
      }, [open]);

      /**
       * Render into the shipped statistics row, so the pills share that row's
       * own gap and centring. The dock is a column flexbox whose outlet erases
       * itself (display:contents), so a second entry would land on a second
       * line; nothing in the slot contract can join the shipped row, and
       * ReactDOM.createPortal is the supported way to render into DOM the
       * platform owns — the shipped pills portal their popovers the same way.
       * Re-resolved on every commit: a re-mounted composer hands us a new row,
       * and a row that is gone drops the pill back onto its own line.
       */
      react.useLayoutEffect(function () {
        var host = hostRef.current;
        if (host === null || host === undefined) return;
        var next = shippedStatsRow(host.previousElementSibling);
        if (next !== portalRow) setPortalRow(next);
      });

      /** Keep the fallback panel inside the viewport on a narrow composer. */
      react.useLayoutEffect(function () {
        if (!open) return;
        var panel = panelRef.current;
        var slot = panel === null || panel === undefined ? null : panel.parentElement;
        if (panel === null || panel === undefined || slot === null || slot === undefined) return;
        if (typeof slot.getBoundingClientRect !== 'function' || typeof panel.getBoundingClientRect !== 'function') return;
        if (typeof window === 'undefined' || typeof window.innerWidth !== 'number') return;
        var rect = slot.getBoundingClientRect();
        var width = panel.getBoundingClientRect().width;
        var flip = rect.left + width > window.innerWidth - 12;
        panel.style.left = flip ? 'auto' : '0';
        panel.style.right = flip ? '0' : 'auto';
      }, [open]);

      /**
       * Ask the host half for the tariff-correct figure. It owns the session
       * log, so it can price every assistant step at the window in force when
       * that step was actually billed — something the aggregate `tokenUsage`
       * projection cannot express. Refetched whenever the durable totals move,
       * and retried while the host says the session is not attached yet: one
       * attempt at start-up would otherwise leave the pill on its estimate
       * until something unrelated re-rendered it.
       */
      var liveSessionId = sessionIdOf(props);
      var liveModelId = modelSel && modelSel.lastUsed ? String(modelSel.lastUsed.model || '') : '';
      var liveTotal = usage
        ? (usage.uncachedInputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0) + (usage.outputTokens || 0)
        : 0;

      react.useEffect(function () {
        if (liveSessionId === null || liveTotal === 0) {
          if (exactRef.current !== null) {
            exactRef.current = null;
            setExact(null);
          }
          return undefined;
        }
        var cancelled = false;
        var timer = null;
        var attempt = 0;
        var query = 'session=' + encodeURIComponent(liveSessionId) + (liveModelId === '' ? '' : '&model=' + encodeURIComponent(liveModelId));

        function settle(next) {
          exactRef.current = next;
          setExact(next);
        }

        function schedule() {
          if (cancelled || attempt >= COST_RETRY_LIMIT) return;
          timer = setTimeout(load, costRetryDelay(attempt));
        }

        function load() {
          attempt += 1;
          var request = null;
          try {
            request = typeof fetch === 'function' ? fetch('/plugins/dsh-usage-dock/cost?' + query, { headers: { accept: 'application/json' } }) : null;
          } catch (error) {
            /* no usable fetch in this shell: the pill keeps its estimate */
            request = null;
          }
          if (request === null) return;
          request
            .then(function (response) {
              if (!response.ok) return { error: 'http-' + response.status };
              return response.json();
            })
            .then(function (body) {
              if (cancelled) return;
              var next = body !== null && typeof body === 'object' && typeof body.total === 'number' && body.steps > 0 ? body : null;
              settle(next);
              if (next === null && costAnswerRetryable(body)) schedule();
            })
            .catch(function () {
              if (cancelled) return;
              if (exactRef.current !== null) settle(null);
              schedule();
            });
        }

        load();
        return function () {
          cancelled = true;
          if (timer !== null) clearTimeout(timer);
        };
      }, [liveSessionId, liveModelId, liveTotal]);

      var view = null;
      if (usage) {
        var uncached = usage.uncachedInputTokens || 0;
        var output = usage.outputTokens || 0;
        var cacheRead = usage.cacheReadTokens || 0;
        var cacheWrite = usage.cacheWriteTokens || 0;
        var total = uncached + output + cacheRead + cacheWrite;
        var selection = modelSel && modelSel.lastUsed ? modelSel.lastUsed : null;
        var provider = selection && typeof selection.provider === 'string' ? selection.provider : null;
        if (total > 0 && (provider === null || PRICED_PROVIDERS.indexOf(provider) !== -1)) {
          var prices = resolvePricing(selection ? selection.model : '');
          var bucket = { uncachedInputTokens: uncached, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite };
          var peakCost = costCNY(bucket, prices);
          var exactCost = exact !== null && typeof exact.total === 'number' ? exact.total : null;
          var nowPeak = exact !== null && typeof exact.nowPeak === 'boolean' ? exact.nowPeak : null;
          /**
           * The figure the pill and the panel pay: the host's per-turn total
           * when it answered, otherwise this aggregate at the window in force
           * right now. Everything below is derived from it, so the buckets can
           * never drift from it.
           */
          var tariff = peakNow({ nowPeak: nowPeak }) ? 1 : 0.5;
          var shown = exactCost === null ? peakCost * tariff : exactCost;
          view = {
            total: total,
            peakCost: peakCost,
            offCost: peakCost / 2,
            exactCost: exactCost,
            exactPeak: exact !== null && typeof exact.peakCost === 'number' ? exact.peakCost : null,
            exactOff: exact !== null && typeof exact.offCost === 'number' ? exact.offCost : null,
            exactSteps: exact !== null && typeof exact.steps === 'number' ? exact.steps : 0,
            nowPeak: nowPeak,
            money: bucketMoney(shown, exact === null ? ESTIMATE : exact.buckets, bucket, prices, tariff),
            hit: hitText(cacheRead, uncached + cacheRead + cacheWrite),
            text: labels()
          };
        }
      }

      /**
       * The rows live in the shipped card, which mounts and unmounts with its
       * own pill, so they are re-synced whenever that card appears and kept
       * current while it stands open.
       */
      syncRef.current = view === null || portalRow === null ? null : function () {
        var dl = openUsageDialog(portalRow);
        if (dl === null) return;
        try {
          syncCostRows(dl, view);
        } catch (error) {
          /* the shipped card is a bonus surface: never break it */
        }
      };

      react.useEffect(function () {
        if (syncRef.current !== null) syncRef.current();
      });

      react.useEffect(function () {
        if (typeof MutationObserver !== 'function' || typeof document === 'undefined' || !document.body) return undefined;
        var observer = new MutationObserver(function () {
          if (syncRef.current !== null) syncRef.current();
        });
        observer.observe(document.body, { childList: true });
        return function () {
          observer.disconnect();
        };
      }, []);

      if (view === null) return null;
      var text = view.text;
      /* One figure per surface, and the same one everywhere. */
      var line = costLine(view);
      var pillCost = line.value;
      var title =
        text.total + ': ' + view.total.toLocaleString() + ' ' + text.unit + '\n' +
        line.label + ': ' + line.amount +
        (line.exact ? '\n' + text.stepsLabel + ': ' + view.exactSteps : '') +
        (view.hit === null ? '' : '\n' + text.hit + ': ' + view.hit);

      var children = [
        react.createElement(
          'button',
          {
            key: 'pill',
            type: 'button',
            className: 'dshu-pill',
            title: title,
            'aria-expanded': open,
            onClick: function () {
              var shipped = shippedUsagePill(portalRow);
              if (shipped !== null) {
                shipped.click();
                return;
              }
              setOpen(!open);
            }
          },
          moneyIcon(),
          react.createElement('span', { className: 'dshu-sign' }, '\u00A5'),
          react.createElement('span', { className: 'dshu-amount dshu-num' }, fmtAmountOnly(pillCost))
        )
      ];

      if (open) {
        children.push(
          react.createElement(
            'div',
            { className: 'dshu-panel', key: 'panel', ref: panelRef },
            row(text.uncached, view.money.text[0], 'u', null, rateHint(text, view.money.rate[0])),
            row(text.cacheRead, view.money.text[1], 'r', null, rateHint(text, view.money.rate[1])),
            row(text.output, view.money.text[2], 'o', null, rateHint(text, view.money.rate[2])),
            row(line.label, line.amount, 'cx', 'dshu-total'),
            line.exact ? row(text.stepsLabel, String(view.exactSteps), 'st') : null,
            view.hit === null ? null : row(text.hit, view.hit, 'h'),
            react.createElement('div', { className: 'dshu-hint' }, line.note)
          )
        );
      }

      var slot = react.createElement('span', { className: 'dshu-slot' }, children);
      var canPortal = portalRow !== null && reactDom !== null && typeof reactDom.createPortal === 'function';

      if (!canPortal) {
        return react.createElement('div', { className: 'dshu-wrap', ref: hostRef, 'data-dsh-usage-dock': 'cost' }, slot);
      }

      return react.createElement(
        react.Fragment,
        null,
        react.createElement('div', { className: 'dshu-host', ref: hostRef, 'data-dsh-usage-dock': 'host' }),
        reactDom.createPortal(slot, portalRow, 'usage-dock')
      );
    }

    /** Client service dependencies: the slot registry only. */
    var inject = ['slots'];

    /**
     * Register the cost pill as the dock's last control. The composer renders
     * the context-occupancy meter right after the dock's controls, so the
     * highest order is what puts the pill immediately left of that meter.
     * The shared order 1 would tie with the shipped `usage` pill, and a tie is
     * resolved by registration order — which is what let the two swap seats
     * between loads.
     * @param ctx - client cordis context.
     */
    function apply(ctx) {
      var slots = ctx && ctx.slots;
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        console.warn('[dsh-usage-dock] slots service unavailable; cost pill not registered');
        return;
      }
      ensureStyle();
      slots.inject('conversation.composer.dock', function () {
        return slots.register(
          { name: 'conversation.composer.dock', id: 'usage-dock', order: 2 },
          UsageCostPill
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.__internals = {
      shippedStatsRow: shippedStatsRow,
      shippedUsagePill: shippedUsagePill,
      openUsageDialog: openUsageDialog,
      syncCostRows: syncCostRows,
      costLine: costLine,
      fmtMoney: fmtMoney,
      fmtAmountOnly: fmtAmountOnly,
      resolvePricing: resolvePricing,
      costCNY: costCNY,
      bucketCosts: bucketCosts,
      bucketMoney: bucketMoney,
      ESTIMATE: ESTIMATE,
      moneyPlaces: moneyPlaces,
      moneySplit: moneySplit,
      moneyText: moneyText,
      rateOf: rateOf,
      fmtRate: fmtRate,
      rateHint: rateHint,
      isPeakNow: isPeakNow,
      hitText: hitText,
      costAnswerRetryable: costAnswerRetryable,
      costRetryDelay: costRetryDelay,
      labels: labels
    };
    return module.exports;
  }
});