'use strict';

// Shared namespace for the content scripts (they share one isolated world).
const TLC = {};

// Google Calendar's calendar palette, in the same order as its color menu.
TLC.PALETTE = [
  ['Radicchio', '#AD1457'], ['Tangerine', '#F4511E'], ['Citron', '#E4C441'], ['Basil', '#0B8043'], ['Blueberry', '#3F51B5'], ['Grape', '#8E24AA'],
  ['Cherry Blossom', '#D81B60'], ['Pumpkin', '#EF6C00'], ['Avocado', '#C0CA33'], ['Eucalyptus', '#009688'], ['Lavender', '#7986CB'], ['Cocoa', '#795548'],
  ['Tomato', '#D50000'], ['Mango', '#F09300'], ['Pistachio', '#7CB342'], ['Peacock', '#039BE5'], ['Wisteria', '#B39DDB'], ['Graphite', '#616161'],
  ['Flamingo', '#E67C73'], ['Banana', '#F6BF26'], ['Sage', '#33B679'], ['Cobalt', '#4285F4'], ['Amethyst', '#9E69AF'], ['Birch', '#A79B8E'],
];

// Order used to give new lists distinct default colors.
TLC.AUTO_COLORS = [
  '#D50000', '#F6BF26', '#0B8043', '#8E24AA', '#F4511E', '#039BE5', '#E67C73', '#33B679',
  '#3F51B5', '#EF6C00', '#7986CB', '#AD1457', '#C0CA33', '#009688', '#795548', '#616161',
];

// ---------------------------------------------------------------------------
// Color math

TLC.color = (() => {
  const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
  const cache = new Map();

  function parse(str) {
    if (!str) return null;
    if (typeof str === 'object') return str;
    if (cache.has(str)) return cache.get(str);
    let out = null;
    const s = String(str).trim();
    let m;
    if ((m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s))) {
      let h = m[1];
      if (h.length === 3) h = [...h].map((c) => c + c).join('');
      out = { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
    } else if ((m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(s))) {
      const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      if (a > 0.5) out = { r: +m[1], g: +m[2], b: +m[3] };
    }
    if (cache.size > 500) cache.clear();
    cache.set(str, out);
    return out;
  }

  const hex = ({ r, g, b }) => '#' + [r, g, b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('').toUpperCase();
  const css = ({ r, g, b }) => `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
  const equal = (a, b) => a && b && Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) <= 3;

  function toHsl({ r, g, b }) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return { h: h * 60, s, l };
  }

  function fromHsl({ h, s, l }) {
    h = ((h % 360) + 360) % 360 / 360;
    if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const f = (t) => {
      t = (t + 1) % 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return { r: f(h + 1 / 3) * 255, g: f(h) * 255, b: f(h - 1 / 3) * 255 };
  }

  function luminance({ r, g, b }) {
    const lin = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  const contrast = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };

  // Is `v` the base color, or a shade Calendar derived from it (lighter for past
  // events, darker borders, and so on)?
  function isShadeOf(v, base) {
    if (equal(v, base)) return true;
    const V = toHsl(v), B = toHsl(base);
    if (B.s < 0.12) return V.s < 0.15 && V.l > 0.08 && V.l < 0.92 && Math.abs(V.l - B.l) < 0.35;
    const dh = Math.min(Math.abs(V.h - B.h), 360 - Math.abs(V.h - B.h));
    return dh <= 20 && V.s > 0.12 && Math.abs(V.l - B.l) < 0.4;
  }

  // Apply the same base -> v transformation to `target`.
  function shift(v, base, target) {
    if (equal(v, base)) return target;
    const V = toHsl(v), B = toHsl(base), T = toHsl(target);
    return fromHsl({
      h: T.h + (V.h - B.h),
      s: B.s > 0.05 ? clamp(T.s * (V.s / B.s)) : T.s,
      l: clamp(T.l + (V.l - B.l), 0.04, 0.96),
    });
  }

  return { parse, hex, css, equal, toHsl, fromHsl, luminance, contrast, isShadeOf, shift };
})();

// ---------------------------------------------------------------------------
// Small DOM helpers

TLC.h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
};

// Material icons as inline SVG (built without innerHTML; Google pages enforce Trusted Types).
TLC.ICONS = {
  check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
  add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
};

TLC.icon = (name, size = 14) => {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', TLC.ICONS[name]);
  svg.append(path);
  return svg;
};

// Tooltip styled like Calendar's own (inverse surface, small text, below the target).
TLC.tooltip = (() => {
  let el = null;
  let timer = 0;
  function show(target, text, { delay = 500, placement = 'bottom' } = {}) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!target.isConnected) return;
      el ||= TLC.h('div', { class: 'tlc-tooltip', role: 'tooltip' });
      el.textContent = text;
      document.body.append(el);
      const r = target.getBoundingClientRect();
      const t = el.getBoundingClientRect();
      let left = r.left + r.width / 2 - t.width / 2;
      left = Math.max(8, Math.min(left, innerWidth - t.width - 8));
      let top = placement === 'top' ? r.top - t.height - 8 : r.bottom + 8;
      if (top + t.height > innerHeight - 8) top = r.top - t.height - 8;
      el.style.left = `${left}px`;
      el.style.top = `${Math.max(8, top)}px`;
      el.classList.add('tlc-tooltip--visible');
    }, delay);
  }
  function hide() {
    clearTimeout(timer);
    el?.classList.remove('tlc-tooltip--visible');
    el?.remove();
  }
  function attach(target, getText, opts) {
    const on = () => {
      const text = typeof getText === 'function' ? getText() : getText;
      if (text) show(target, text, opts);
    };
    target.addEventListener('mouseenter', on);
    target.addEventListener('focus', on);
    target.addEventListener('mouseleave', hide);
    target.addEventListener('blur', hide);
    target.addEventListener('pointerdown', hide);
  }
  return { show, hide, attach };
})();

// The signed-in Calendar account, e.g. "name@gmail.com" (read from the account button).
TLC.pageAccount = (() => {
  let cached = null;
  let at = 0;
  return () => {
    if (cached && Date.now() - at < 30_000) return cached;
    cached = null;
    for (const el of document.querySelectorAll('a[aria-label*="@"]')) {
      const m = /\(([^()\s]+@[^()\s]+)\)/.exec(el.getAttribute('aria-label') || '');
      if (m) {
        cached = m[1].toLowerCase();
        at = Date.now();
        break;
      }
    }
    return cached;
  };
})();

TLC.alive = () => {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
};

TLC.send = async (msg) => {
  if (!TLC.alive()) return { ok: false, error: 'Extension was reloaded' };
  try {
    return (await chrome.runtime.sendMessage(msg)) || { ok: false };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
};
