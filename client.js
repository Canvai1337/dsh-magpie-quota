/**
 * Browser half of the Magpie quota bundle.
 *
 * Adds one compact reading to `conversation.composer.dock`, in the same
 * statistics row as the shipped context meter: a small battery glyph and the
 * lowest remaining account percentage. Clicking it opens a "call-out" panel
 * anchored above the trigger that mirrors the shipped context meter's popover
 * (same menu surface, elevation, radius, type scale, dismiss behavior, Escape
 * handling), and breaks the quota down per account and per usage window.
 *
 * Data comes from the Host route `/__local/magpie-quota`, which reads the local
 * magpie gateway (server-side, so the browser stays same-origin). The reading
 * refreshes on mount, whenever the panel opens, on tab focus, and every
 * POL_MS while the page is visible, so it does not drift during long sessions.
 * The panel is portaled so the dock's overflow never clips it, repositions
 * against the trigger on scroll/resize, and flips below when space above is
 * tight.
 */
window.__ModuleLoader__.load({
  id: '@local/magpie-quota',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    let createPortal = null;
    try {
      const dom = require('react-dom');
      createPortal = dom && typeof dom.createPortal === 'function' ? dom.createPortal : null;
    } catch {
      createPortal = null;
    }

    const NS = 'magpieQuota';
    /** Bound once in apply; stable identity, reads the active locale at call time. */
    let boundT = key => key;

    /** Same-origin Host route registered by the Host half. */
    const QUOTA_ROUTE = '/__local/magpie-quota';
    /** Background refresh cadence while the page is visible. */
    const POLL_MS = 60000;

    const zh = {
      'title': 'magpie 额度',
      'totalQuota': '总额度',
      'triggerAria': 'magpie 额度：最低剩余 {pct}',
      'triggerAriaUnknown': 'magpie 额度',
      'staleSuffix': '（数据可能已过期）',
      'updated': '更新于 {time}',
      'refresh': '刷新',
      'close': '关闭',
      'loading': '正在读取额度…',
      'error': '无法读取 magpie 额度',
      'retry': '重试',
      'empty': '没有可显示的账号额度',
      'remaining': '剩余 {pct}%',
      'reset': '重置 {date}',
      'runsOut': '预计 {date} 用尽',
      'expired': '已过期',
      'errTimeout': '读取额度超时',
      'errUnreachable': '无法连接 magpie 网关',
      'errGateway': 'magpie 网关返回错误（HTTP {status}）',
      'errBadJson': 'magpie 网关返回了无法解析的数据',
      'errBadFormat': '额度数据格式无效',
      'errNetwork': '读取额度失败',
    };
    const en = {
      'title': 'Magpie quota',
      'totalQuota': 'Total quota',
      'triggerAria': 'Magpie quota: lowest {pct} remaining',
      'triggerAriaUnknown': 'Magpie quota',
      'staleSuffix': ' (data may be stale)',
      'updated': 'Updated {time}',
      'refresh': 'Refresh',
      'close': 'Close',
      'loading': 'Reading quota…',
      'error': 'Could not read the magpie quota',
      'retry': 'Retry',
      'empty': 'No account quota to show',
      'remaining': '{pct}% left',
      'reset': 'resets {date}',
      'runsOut': 'runs out {date}',
      'expired': 'Expired',
      'errTimeout': 'Quota read timed out',
      'errUnreachable': 'Cannot reach the magpie gateway',
      'errGateway': 'Magpie gateway error (HTTP {status})',
      'errBadJson': 'The magpie gateway returned unreadable data',
      'errBadFormat': 'The quota data format is invalid',
      'errNetwork': 'Could not read the quota',
    };

    /** Fill `{name}` placeholders after translation. */
    function fill(template, params) {
      return String(template).replace(/\{(\w+)\}/g, (whole, name) =>
        params && params[name] !== undefined ? String(params[name]) : whole);
    }

    /** Read a finite number, else undefined. */
    function num(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    }

    /** Read a string, else ''. */
    function str(value) {
      return typeof value === 'string' ? value : '';
    }

    /** Clamp a percentage into [0, 100]; undefined stays undefined. */
    function clampPct(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
      return Math.max(0, Math.min(100, value));
    }

    /** Proximity band of a (rounded) remaining percentage. */
    function levelOf(remaining) {
      if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return 'neutral';
      if (remaining >= 50) return 'green';
      if (remaining >= 20) return 'yellow';
      return 'red';
    }

    const LEVEL_COLOR = {
      green: 'var(--dsw-alias-state-success-primary, #2f9e44)',
      yellow: 'var(--dsw-alias-state-warn-primary, #d29922)',
      red: 'var(--dsw-alias-state-error-primary, #d64545)',
      neutral: 'var(--dsw-alias-label-tertiary, #8b8b8b)',
    };

    /** Short locale-formatted date (month/day, plus year when it differs) for a reset or run-out instant. */
    function formatDate(iso) {
      if (!iso) return '';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      const options = { month: 'numeric', day: 'numeric' };
      if (date.getFullYear() !== new Date().getFullYear()) options.year = 'numeric';
      try {
        return date.toLocaleDateString(undefined, options);
      } catch {
        return '';
      }
    }

    /** Short locale-formatted clock time for the last successful read. */
    function formatTime(iso) {
      if (!iso) return '';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      try {
        return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      } catch {
        return '';
      }
    }

    /** True when an `until` timestamp is in the past (account no longer usable). */
    function isExpired(until) {
      if (!until) return false;
      const date = new Date(until);
      return !Number.isNaN(date.getTime()) && date.getTime() < Date.now();
    }

    /**
     * The percentage a single account should advertise: its "Total" window when
     * one exists (the figure that governs the whole account), otherwise the most
     * constrained of its windows. The panel lists every window, so a spent
     * sub-bucket stays visible on open.
     */
    function headlineRemaining(windows) {
      let total;
      for (const window of windows) {
        if (/total/i.test(window.name) && typeof window.remainingPct === 'number') {
          total = window;
          break;
        }
      }
      if (total !== undefined) return total.remainingPct;
      let best;
      for (const window of windows) {
        if (typeof window.remainingPct === 'number') {
          best = best === undefined ? window.remainingPct : Math.min(best, window.remainingPct);
        }
      }
      return best;
    }

    /** Normalize the gateway payload into the shape the panel renders. */
    function normalize(raw) {
      const list = raw && Array.isArray(raw.data) ? raw.data : [];
      const accounts = [];
      for (const provider of list) {
        if (provider === null || typeof provider !== 'object') continue;
        const windows = Array.isArray(provider.windows)
          ? provider.windows.filter(w => w !== null && typeof w === 'object').map(w => ({
              name: str(w.name),
              usedPct: clampPct(num(w.used)),
              remainingPct: clampPct(num(w.remaining)),
              amount: num(w.amount),
              limit: num(w.limit),
              unit: str(w.unit),
              display: str(w.display),
              resetsAt: str(w.resetsAt) || null,
              runsOutAt: str(w.runsOutAt) || null,
            }))
          : [];
        const until = str(provider.until) || null;
        accounts.push({
          id: str(provider.provider) || str(provider.name) || 'account',
          name: str(provider.name) || str(provider.provider) || '',
          plan: str(provider.plan),
          user: str(provider.user),
          alias: str(provider.alias),
          until,
          expired: isExpired(until),
          windows,
          headline: headlineRemaining(windows),
        });
      }
      return { accounts, fetchedAt: str(raw && raw.fetchedAt) || null };
    }

    /** Lowest remaining percentage across usable accounts; expired accounts are excluded. */
    function summaryPct(data) {
      if (!data || data.accounts.length === 0) return null;
      let best = null;
      for (const account of data.accounts) {
        if (account.expired) continue;
        if (typeof account.headline === 'number') {
          best = best === null ? account.headline : Math.min(best, account.headline);
        }
      }
      return best;
    }

    /** Localized error sentence for a state.error descriptor. */
    function describeError(t, error) {
      if (!error) return t('error');
      switch (error.code) {
        case 'timeout': return t('errTimeout');
        case 'unreachable': return t('errUnreachable');
        case 'network': return t('errNetwork');
        case 'gateway-error': return fill(t('errGateway'), { status: error.status !== undefined ? error.status : '?' });
        case 'bad-json': return t('errBadJson');
        case 'bad-format': return t('errBadFormat');
        default:
          return error.message ? `${t('error')} — ${error.message}` : t('error');
      }
    }

    const STYLE = [
      '.dsh-mq-root{display:inline-flex;flex:none;}',
      // Wrapper keeps the trigger button from being a direct child of the root
      // span; the neighboring context-compaction-meter hides direct-child
      // trigger spans, so this keeps the quota chip visible in every layout.
      '.dsh-mq-btnwrap{display:inline-flex;align-items:center;flex:none;}',
      // Trigger matches the shipped ContextMeter chip exactly (same height,
      // padding, type scale and hover/expanded treatment).
      '.dsh-mq-trigger{position:relative;display:inline-flex;align-items:center;gap:6px;flex:none;padding:1px 8px;border:none;border-radius:var(--dsw-radius-sm,4px);background:transparent;color:var(--dsw-alias-label-tertiary,#8b8b8b);font-family:inherit;font-size:var(--dsh-content-font-size-secondary,13px);font-variant-numeric:tabular-nums;line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:nowrap;cursor:pointer;}',
      '.dsh-mq-trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary,#666);}',
      '@media (hover:hover){.dsh-mq-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary,#666);}}',
      '.dsh-mq-trigger:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4f7bd8));outline-offset:1px;}',
      // A stale reading (last refresh failed while showing old data) gets a dot.
      '.dsh-mq-trigger[data-stale="1"]::after{content:"";position:absolute;top:2px;right:2px;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#d29922);}',
      '.dsh-mq-batt{display:block;overflow:visible;}',
      '.dsh-mq-pct{font-variant-numeric:tabular-nums;}',
      // Panel: the shipped ContextMeter popover surface (menu, elevation-prominent).
      '.dsh-mq-panel{position:fixed;z-index:1100;box-sizing:border-box;padding:12px;border:0;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-specific-menu,Canvas);backdrop-filter:var(--dsw-menu-backdrop-filter,blur(12px));--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent,0 8px 28px rgba(0,0,0,.24));font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary,#666);cursor:default;max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);overflow-x:hidden;overflow-y:auto;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);outline:none;}',
      '.dsh-mq-head{display:flex;align-items:center;gap:6px;margin-bottom:8px;}',
      '.dsh-mq-title{font-weight:500;color:var(--dsw-alias-label-primary,CanvasText);}',
      '.dsh-mq-updated{color:var(--dsw-alias-label-tertiary,#8b8b8b);font-variant-numeric:tabular-nums;font-size:11px;}',
      '.dsh-mq-actions{display:inline-flex;align-items:center;gap:2px;margin-left:auto;flex:none;}',
      '.dsh-mq-iconbtn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;border-radius:var(--dsw-radius-sm,4px);background:transparent;color:var(--dsw-alias-label-tertiary,#8b8b8b);font-size:14px;line-height:1;cursor:pointer;}',
      '@media (hover:hover){.dsh-mq-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary,#666);}}',
      '.dsh-mq-iconbtn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4f7bd8));outline-offset:1px;}',
      '@keyframes dsh-mq-spin{to{transform:rotate(360deg);}}.dsh-mq-spin{display:inline-block;animation:dsh-mq-spin .9s linear infinite;transform-origin:center;}',
      '@media (prefers-reduced-motion:reduce){.dsh-mq-spin{animation:none;}}',
      '.dsh-mq-acct{padding:8px 0;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));}',
      '.dsh-mq-acct:first-child{border-top:0;padding-top:0;}',
      '.dsh-mq-acct-expired .dsh-mq-item{opacity:.55;}',
      '.dsh-mq-accthead{display:flex;align-items:baseline;gap:6px;margin-bottom:6px;}',
      '.dsh-mq-acctname{font-weight:500;color:var(--dsw-alias-label-primary,CanvasText);white-space:nowrap;}',
      '.dsh-mq-acctsub{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#8b8b8b);font-size:11px;}',
      '.dsh-mq-acctremain{margin-left:auto;flex:none;font-weight:500;font-variant-numeric:tabular-nums;}',
      '.dsh-mq-item{padding:5px 0 3px;}',
      '.dsh-mq-item + .dsh-mq-item{border-top:1px dashed var(--dsw-alias-border-l1,rgba(127,127,127,.18));margin-top:2px;padding-top:6px;}',
      '.dsh-mq-itemhead{display:flex;align-items:baseline;gap:8px;}',
      '.dsh-mq-itemname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#666);}',
      '.dsh-mq-itemfig{flex:none;margin-left:8px;color:var(--dsw-alias-label-tertiary,#8b8b8b);font-variant-numeric:tabular-nums;font-size:11px;}',
      '.dsh-mq-itemval{flex:none;margin-left:8px;font-weight:500;font-variant-numeric:tabular-nums;}',
      '.dsh-mq-bar{display:flex;height:4px;margin:5px 0 0;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));overflow:hidden;}',
      '.dsh-mq-fill{flex:none;height:100%;border-radius:1px;background:var(--mq-tint,var(--dsw-alias-label-tertiary,#8b8b8b));}',
      '.dsh-mq-status{padding:8px 0;color:var(--dsw-alias-label-tertiary,#8b8b8b);}',
      '.dsh-mq-error{display:flex;align-items:flex-start;gap:8px;padding:6px 7px;margin-bottom:6px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-interactive-bg-hover-danger,rgba(214,69,69,.12));color:var(--dsw-alias-state-error-primary,#d64545);font-size:11px;line-height:16px;}',
      '.dsh-mq-errtext{flex:1;min-width:0;overflow-wrap:anywhere;}',
      '.dsh-mq-retry{flex:none;padding:0;border:none;background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer;}',
    ].join('\n');

    /** Battery glyph: outline double-cells, fill = remaining share, colored by level. */
    function BatteryGlyph(props) {
      const pct = typeof props.pct === 'number' ? Math.max(0, Math.min(100, props.pct)) : 0;
      const color = props.color || 'var(--dsw-alias-label-tertiary,#8b8b8b)';
      const inner = 10.8 * pct / 100;
      return h('svg', {
        viewBox: '0 0 18 14', width: 16, height: 12, 'aria-hidden': 'true', className: 'dsh-mq-batt',
      },
        h('rect', { x: 1, y: 2.5, width: 13, height: 9, rx: 2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }),
        h('rect', { x: 14.6, y: 5.2, width: 2, height: 3.6, rx: 1, fill: 'currentColor' }),
        inner > 0 ? h('rect', { x: 2.6, y: 4.1, width: inner, height: 5.8, rx: 1, fill: color }) : null,
      );
    }

    /** The account's overall quota window ("Total"), falling back to a credit bucket. */
    function totalWindowOf(windows) {
      for (const window of windows) {
        if (/total/i.test(window.name)) return window;
      }
      for (const window of windows) {
        if (window.unit === 'credits') return window;
      }
      return windows.length > 0 ? windows[0] : null;
    }

    /** The account's single model usage-limit window, or null when it has none. */
    function modelWindowOf(windows, total) {
      const candidates = windows.filter(window => window !== total);
      const tokenLike = candidates.filter(window => /token|模型|model/i.test(window.name));
      if (tokenLike.length > 0) return tokenLike[0];
      const nonCredit = candidates.filter(window =>
        window.unit !== 'credits'
        && ((typeof window.limit === 'number' && window.limit > 0) || typeof window.remainingPct === 'number'));
      return nonCredit.length > 0 ? nonCredit[0] : null;
    }

    /** Percentage used for a window's bar, with amount/limit and remaining fallbacks. */
    function usedPercentOf(window) {
      let usedPct = typeof window.usedPct === 'number' ? window.usedPct : undefined;
      if ((usedPct === undefined || usedPct > 100.5)
        && typeof window.amount === 'number' && typeof window.limit === 'number' && window.limit > 0) {
        usedPct = window.amount / window.limit * 100;
      }
      if (usedPct === undefined && typeof window.remainingPct === 'number') usedPct = 100 - window.remainingPct;
      return usedPct === undefined ? 0 : Math.max(0, Math.min(100, usedPct));
    }

    /** The gateway's amount/limit string for a window, with a numeric fallback. */
    function figuresOf(window) {
      if (window.display !== '') return window.display;
      if (typeof window.amount === 'number' && typeof window.limit === 'number') return `${window.amount} / ${window.limit}`;
      if (typeof window.limit === 'number') return `— / ${window.limit}`;
      return '';
    }

    /** One simplified line: a label, its amount (积分量), its remaining percentage, and a bar. */
    function quotaItem(label, window, key) {
      const remaining = typeof window.remainingPct === 'number' ? Math.round(window.remainingPct) : undefined;
      const tint = LEVEL_COLOR[levelOf(remaining)];
      const figures = figuresOf(window);
      return h('div', { key, className: 'dsh-mq-item' },
        h('div', { className: 'dsh-mq-itemhead' },
          h('span', { className: 'dsh-mq-itemname', title: label }, label),
          figures !== '' ? h('span', { className: 'dsh-mq-itemfig' }, figures) : null,
          h('span', { className: 'dsh-mq-itemval', style: { color: tint } },
            remaining === undefined ? '—' : `${remaining}%`),
        ),
        h('div', { className: 'dsh-mq-bar' },
          h('div', { className: 'dsh-mq-fill', style: { width: `${usedPercentOf(window)}%`, background: tint } }),
        ),
      );
    }

    /**
     * Each account shows exactly two things: its overall quota percentage, and
     * one model usage-limit percentage when the account has such a window. Credit
     * sub-buckets (Credits / Extra credits) are intentionally not listed.
     */
    function accountBlock(account, key) {
      const sub = [account.plan, account.alias || account.user].filter(Boolean).join(' · ');
      const items = [];
      if (!account.expired) {
        const total = totalWindowOf(account.windows);
        if (total !== null) items.push(quotaItem(boundT('totalQuota'), total, `${key}:total`));
        const model = modelWindowOf(account.windows, total);
        if (model !== null) items.push(quotaItem(model.name, model, `${key}:model`));
      }
      const badge = account.expired
        ? h('span', { className: 'dsh-mq-acctremain', style: { color: 'var(--dsw-alias-label-tertiary,#8b8b8b)' } }, boundT('expired'))
        : null;
      return h('div', { key, className: account.expired ? 'dsh-mq-acct dsh-mq-acct-expired' : 'dsh-mq-acct' },
        h('div', { className: 'dsh-mq-accthead' },
          h('span', { className: 'dsh-mq-acctname' }, account.name),
          sub !== '' ? h('span', { className: 'dsh-mq-acctsub' }, sub) : null,
          badge,
        ),
        items,
      );
    }

    function QuotaMeter() {
      const t = boundT;
      const [state, setState] = React.useState({ status: 'loading', data: null, error: null });
      const [open, setOpen] = React.useState(false);
      const [pos, setPos] = React.useState(null);
      const rootRef = React.useRef(null);
      const btnRef = React.useRef(null);
      const panelRef = React.useRef(null);
      const abortRef = React.useRef(null);
      const mountedRef = React.useRef(true);

      const load = React.useCallback(() => {
        if (abortRef.current !== null) abortRef.current.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        setState(prev => ({ status: 'loading', data: prev.data, error: null }));
        const url = new URL(QUOTA_ROUTE, document.baseURI).toString();
        void (async () => {
          try {
            const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
            let payload = null;
            try { payload = await response.json(); } catch { /* non-JSON failure */ }
            if (!response.ok) {
              const failure = new Error(payload && typeof payload.message === 'string' ? payload.message : `HTTP ${response.status}`);
              failure.code = payload && typeof payload.code === 'string' ? payload.code : 'network';
              failure.status = response.status;
              throw failure;
            }
            if (payload === null || !Array.isArray(payload.data)) {
              const failure = new Error('bad-format');
              failure.code = 'bad-format';
              throw failure;
            }
            if (controller.signal.aborted || !mountedRef.current) return;
            setState({ status: 'ready', data: normalize(payload), error: null });
          } catch (error) {
            if (controller.signal.aborted || !mountedRef.current) return;
            setState(prev => ({
              status: 'error',
              data: prev.data,
              error: {
                code: error && typeof error.code === 'string' ? error.code : 'network',
                status: error ? error.status : undefined,
                message: error instanceof Error ? error.message : String(error),
              },
            }));
          } finally {
            if (abortRef.current === controller) abortRef.current = null;
          }
        })();
      }, []);

      // Initial read plus a bounded background refresh so the chip stays current
      // during long sessions. Background ticks only run while the tab is visible.
      React.useEffect(() => {
        mountedRef.current = true;
        load();
        const timer = setInterval(() => {
          if (typeof document === 'undefined' || document.visibilityState === 'visible') load();
        }, POLL_MS);
        const onVisible = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'visible') load();
        };
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
        if (typeof window !== 'undefined') window.addEventListener('focus', onVisible);
        return () => {
          mountedRef.current = false;
          clearInterval(timer);
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
          if (typeof window !== 'undefined') window.removeEventListener('focus', onVisible);
          if (abortRef.current !== null) abortRef.current.abort();
        };
      }, [load]);

      // Place the panel above the trigger like the native meter; when the space
      // above is too small, flip below so the first rows are never off-screen.
      function reposition() {
        const el = btnRef.current;
        if (el === null || typeof window === 'undefined') return;
        const rect = el.getBoundingClientRect();
        const width = Math.max(240, Math.min(360, window.innerWidth - 16));
        const margin = 8;
        const gap = 8;
        const left = Math.min(Math.max(margin, rect.left), Math.max(margin, window.innerWidth - width - margin));
        const spaceAbove = rect.top - gap - margin;
        const spaceBelow = window.innerHeight - rect.bottom - gap - margin;
        const openUp = spaceAbove >= 220 || spaceAbove >= spaceBelow;
        if (openUp) {
          setPos({
            mode: 'up', left, width,
            bottom: Math.max(margin, window.innerHeight - rect.top + gap),
            maxHeight: Math.max(80, spaceAbove),
          });
        } else {
          setPos({
            mode: 'down', left, width,
            top: rect.bottom + gap,
            maxHeight: Math.max(80, spaceBelow),
          });
        }
      }

      React.useLayoutEffect(() => {
        if (!open) return undefined;
        reposition();
        const panel = panelRef.current;
        if (panel !== null && typeof panel.focus === 'function') panel.focus();
        const onMove = () => reposition();
        window.addEventListener('resize', onMove);
        window.addEventListener('scroll', onMove, true);
        return () => {
          window.removeEventListener('resize', onMove);
          window.removeEventListener('scroll', onMove, true);
        };
      }, [open]);

      React.useEffect(() => {
        if (!open) return undefined;
        load();
        const onDown = event => {
          if (panelRef.current && panelRef.current.contains(event.target)) return;
          if (rootRef.current && rootRef.current.contains(event.target)) return;
          setOpen(false);
        };
        const onKey = event => { if (event.key === 'Escape') setOpen(false); };
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('pointerdown', onDown, true);
          document.removeEventListener('keydown', onKey);
        };
      }, [open, load]);

      const data = state.data;
      const pct = summaryPct(data);
      const roundedPct = typeof pct === 'number' ? Math.round(pct) : null;
      const level = levelOf(roundedPct === null ? undefined : roundedPct);
      const color = LEVEL_COLOR[level];
      const pctText = roundedPct === null ? '—' : `${roundedPct}%`;
      const stale = state.status === 'error' && data !== null;
      const baseAria = roundedPct === null
        ? t('triggerAriaUnknown')
        : fill(t('triggerAria'), { pct: `${roundedPct}%` });
      const aria = stale ? `${baseAria}${t('staleSuffix')}` : baseAria;
      const showSpin = state.status === 'loading';

      const body = [];
      if (state.error !== null) {
        body.push(h('div', { key: 'error', className: 'dsh-mq-error', role: 'alert' },
          h('span', { className: 'dsh-mq-errtext' }, describeError(t, state.error)),
          h('button', { type: 'button', className: 'dsh-mq-retry', onClick: () => load() }, t('retry')),
        ));
      }
      if (data === null && showSpin) {
        body.push(h('div', { key: 'loading', className: 'dsh-mq-status' }, t('loading')));
      }
      if (data !== null) {
        if (data.accounts.length === 0) {
          body.push(h('div', { key: 'empty', className: 'dsh-mq-status' }, t('empty')));
        } else {
          data.accounts.forEach((account, index) => {
            body.push(accountBlock(account, `${index}:${account.id}`));
          });
        }
      }

      const updated = data && data.fetchedAt ? formatTime(data.fetchedAt) : '';
      const panelStyle = pos === null ? undefined : (pos.mode === 'down'
        ? { left: `${pos.left}px`, top: `${pos.top}px`, width: `${pos.width}px`, maxHeight: `${pos.maxHeight}px`, bottom: 'auto' }
        : { left: `${pos.left}px`, bottom: `${pos.bottom}px`, width: `${pos.width}px`, maxHeight: `${pos.maxHeight}px` });

      const panel = h('div', {
        ref: panelRef,
        className: 'dsh-mq-panel',
        role: 'dialog',
        tabIndex: -1,
        'aria-label': t('title'),
        style: panelStyle,
      },
        h('div', { className: 'dsh-mq-head' },
          h('span', { className: 'dsh-mq-title' }, t('title')),
          updated !== '' ? h('span', { className: 'dsh-mq-updated' }, fill(t('updated'), { time: updated })) : null,
          h('span', { className: 'dsh-mq-actions' },
            h('button', {
              type: 'button', className: 'dsh-mq-iconbtn', title: t('refresh'), 'aria-label': t('refresh'),
              onClick: () => load(),
            }, h('span', { className: showSpin ? 'dsh-mq-spin' : undefined, 'aria-hidden': 'true' }, '⟳')),
            h('button', {
              type: 'button', className: 'dsh-mq-iconbtn', title: t('close'), 'aria-label': t('close'),
              onClick: () => setOpen(false),
            }, '×'),
          ),
        ),
        body,
      );

      return h('span', { ref: rootRef, className: 'dsh-mq-root' },
        h('span', { className: 'dsh-mq-btnwrap' },
          h('button', {
            ref: btnRef,
            type: 'button',
            className: 'dsh-mq-trigger',
            title: aria,
            'aria-label': aria,
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            'data-stale': stale ? '1' : undefined,
            onClick: () => setOpen(value => !value),
          },
            h(BatteryGlyph, { pct: typeof pct === 'number' ? pct : 0, color }),
            h('span', { className: 'dsh-mq-pct' }, pctText),
          ),
        ),
        open ? (createPortal ? createPortal(panel, document.body) : panel) : null,
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // A reload can re-enter apply before the previous dictionary disposer
        // runs; keep the second mount harmless instead of failing the plugin.
        ctx.effect(() => {
          try { return ctx.locale.register(NS, { zh, en }); }
          catch { return () => {}; }
        });
        // Inject the stylesheet once per document instead of once per mounted
        // composer, so split/multi-composer layouts do not stack <style> tags.
        if (typeof document !== 'undefined' && document.head) {
          ctx.effect(() => {
            const el = document.createElement('style');
            el.setAttribute('data-dsh-magpie-quota', '1');
            el.textContent = STYLE;
            document.head.appendChild(el);
            return () => { if (el.parentNode) el.parentNode.removeChild(el); };
          });
        }
        boundT = ctx.locale.bind(NS);
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'magpie-quota',
          order: 4,
          locale: NS,
        }, QuotaMeter));
      },
      /** Pure helpers exposed for offline logic tests; the Loader ignores extra exports. */
      _internals: { fill, normalize, summaryPct, headlineRemaining, levelOf, describeError, totalWindowOf, modelWindowOf, usedPercentOf, figuresOf, Component: QuotaMeter },
    };
  },
});
