// Render-level check: the battery glyph's fill width and the number beside it
// must come from the same value, and that value must be the all-account usable
// share. Uses a stub React + stub fetch so the real store path is exercised.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'client.js'), 'utf8');

const LIVE = {
  fetchedAt: '2026-11-17T12:40:00Z',
  data: [
    {
      provider: 'account-1', name: 'AI account 1', plan: 'Free plan', user: '用户 A',
      windows: [
        { name: 'Credits', used: 100, remaining: 0, display: '500 / 500', amount: 500, limit: 500, unit: 'credits' },
        { name: 'Total credits', used: 84.38, remaining: 15.62, display: '3825.81 / 4534', amount: 3825.81, limit: 4534, unit: 'credits' },
      ],
    },
    { provider: 'account-2', name: 'AI account 2', plan: 'Free plan', user: 'a***@example.com',
      windows: [{ name: 'Credits', used: 32.26, remaining: 67.74, display: '32.26 / 100', amount: 32.26, limit: 100, unit: 'credits' }] },
    { provider: 'account-3', name: 'AI account 3', plan: 'Credits', user: '用户 C',
      windows: [{ name: 'Credits', used: 20.82, remaining: 79.18, display: '541.25 / 2600', amount: 541.25, limit: 2600, unit: 'credits' }] },
    { provider: 'account-4', name: 'AI account 4', plan: 'Credits', user: '用户 D',
      windows: [{ name: 'Credits', used: 0.23, remaining: 99.77, display: '4.93 / 2100', amount: 4.93, limit: 2100, unit: 'credits' }] },
  ],
};

let factory;
new Function('window', 'document', 'fetch', source)(
  {
    __ModuleLoader__: { load: ({ factory: f }) => { factory = f; } },
    addEventListener() {}, removeEventListener() {},
  },
  {
    baseURI: 'http://127.0.0.1:9258/', head: null, visibilityState: 'visible',
    addEventListener() {}, removeEventListener() {},
  },
  // Same-origin Host route answer, as the browser would receive it.
  async () => ({ ok: true, status: 200, json: async () => LIVE }),
);

const el = (type, props, ...children) => ({
  type,
  props: props ?? {},
  children: children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false),
});
const React = {
  createElement: el,
  useState: init => [typeof init === 'function' ? init() : init, () => {}],
  useEffect() {},
  useLayoutEffect() {},
  useRef: () => ({ current: null }),
  // Keep the real store alive by subscribing, then read its live snapshot.
  useSyncExternalStore: (subscribe, getState) => { subscribe(() => {}); return getState(); },
};

const mod = factory(id => {
  if (id === 'react') return React;
  if (id === 'react-dom') return {};
  throw new Error(`unexpected require: ${id}`);
});

let Meter;
let dict = {};
mod.apply({
  effect: fn => fn(),
  // Mirror the real locale service: keep the registered dictionary and let the
  // bound translator resolve keys against the zh entry, so the aria label is
  // checked as users actually see it.
  locale: {
    register: (_ns, entries) => { dict = entries; return () => {}; },
    bind: () => key => (dict.zh && dict.zh[key] !== undefined ? dict.zh[key] : key),
  },
  slots: { inject: (_slot, register) => register(), register: (_slot, component) => { Meter = component; } },
});

// First render mounts the subscriber and starts the deduped fetch.
Meter();
await new Promise(resolve => setTimeout(resolve, 100));
const tree = Meter();

const wrap = tree.children.find(c => c && c.props && c.props.className === 'dsh-mq-btnwrap');
const button = wrap.children.find(c => c && c.type === 'button');
const glyphEl = button.children.find(c => c && c.type && c.type.name === 'BatteryGlyph');
const textEl = button.children.find(c => c && c.props && c.props.className === 'dsh-mq-pct');

const svg = glyphEl.type(glyphEl.props);
const fillRect = svg.children.find(c => c && c.props
  && typeof c.props.width === 'number'
  && c.props.fill !== 'none' && c.props.fill !== 'currentColor');

const shown = textEl.children.join('');
const pct = Math.round(mod._internals.usableSharePct(mod._internals.normalize(LIVE)));
const expectedWidth = 10.8 * pct / 100;

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

check('store delivered the payload', pct === 53, `pct=${pct}`);
check('number shows the pool share', shown === `${pct}%`, `shown=${shown}`);
check('glyph fill matches the number', fillRect !== undefined && Math.abs(fillRect.props.width - expectedWidth) < 1e-9,
  `width=${fillRect && fillRect.props.width} expected=${expectedWidth.toFixed(3)}`);
check('glyph fill is not the lowest account (16%)', fillRect !== undefined && Math.abs(fillRect.props.width - 10.8 * 0.16) > 0.5,
  `width=${fillRect && fillRect.props.width.toFixed(3)}`);
check('glyph fill is not the best account (100%)', fillRect !== undefined && fillRect.props.width < 10.8,
  `width=${fillRect && fillRect.props.width.toFixed(3)}`);
check('aria label states the pool share', button.props['aria-label'].includes(`${pct}%`)
  && /全部账号/.test(button.props['aria-label']), button.props['aria-label']);

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.detail})`);
const failed = results.filter(r => !r.ok);
console.log(failed.length === 0 ? 'ALL RENDER CHECKS PASSED' : `${failed.length} RENDER CHECK(S) FAILED`);
process.exit(failed.length === 0 ? 0 : 1);
