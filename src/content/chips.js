'use strict';

// Recolors and hides task chips in the calendar grid, the schedule view and
// the task details popup.
//
// Calendar paints chips with inline styles that are shades of the Tasks
// calendar color (the color itself, a lighter tint for past days, a darker
// border, and so on). Each of those inline colors is mapped onto the list's
// color with the same shift, so every chip variant keeps its native look.

TLC.chips = (() => {
  const CHIP = '[data-eventchip][data-eventid^="tasks_"]';
  const DIALOG_TASK = '[role="dialog"] [data-taskid]';
  const COLOR_PROP = /(^|-)color$|^fill$|^stroke$/;
  const WHITE = { r: 255, g: 255, b: 255 };
  const DARK = { r: 31, g: 31, b: 31 };

  // element -> { [cssProperty]: { orig, mine }, __text: { orig, mine, native, cls } }
  const records = new WeakMap();
  const unknown = new Set();

  // ---------------------------------------------------------------------------
  // Painting

  function paint(root, base, target, { text = true } = {}) {
    for (const el of [root, ...root.querySelectorAll('[style]')]) {
      const style = el.style;
      let rec = records.get(el);
      const props = new Set(rec ? Object.keys(rec).filter((k) => k !== '__text') : []);
      for (let i = 0; i < style.length; i++) if (COLOR_PROP.test(style[i])) props.add(style[i]);

      let filled = null;
      for (const prop of props) {
        const cur = style.getPropertyValue(prop);
        const prev = rec?.[prop];
        const orig = prev && cur === prev.mine ? prev.orig : cur;
        const parsed = orig ? TLC.color.parse(orig) : null;
        if (!parsed || !TLC.color.isShadeOf(parsed, base)) {
          if (prev) {
            if (cur === prev.mine) style.setProperty(prop, prev.orig);
            delete rec[prop];
          }
          continue;
        }
        const next = TLC.color.css(TLC.color.shift(parsed, base, target));
        if (cur !== next || style.getPropertyPriority(prop) !== 'important') style.setProperty(prop, next, 'important');
        if (!rec) records.set(el, (rec = {}));
        rec[prop] = { orig, mine: style.getPropertyValue(prop) };
        if (prop === 'background-color') filled = TLC.color.parse(next);
      }
      if (text) fixText(el, rec, filled);
    }
  }

  // Keep Calendar's own text color unless it becomes unreadable on the new
  // background, e.g. white text on Banana.
  function fixText(el, rec, bg) {
    const style = el.style;
    const prev = rec?.__text;
    const cur = style.getPropertyValue('color');
    const ours = !!prev && cur === prev.mine;
    if (!bg || rec.color) {
      if (prev) {
        if (ours) style.setProperty('color', prev.orig);
        delete rec.__text;
      }
      return;
    }
    let native = ours && prev.cls === el.className ? prev.native : null;
    if (!native) {
      if (ours) style.setProperty('color', prev.orig);
      native = TLC.color.parse(getComputedStyle(el).color);
    }
    const orig = ours ? prev.orig : cur;
    if (native && TLC.color.contrast(native, bg) < 2.5) {
      const want = TLC.color.contrast(WHITE, bg) >= TLC.color.contrast(DARK, bg) ? '#ffffff' : '#1f1f1f';
      if (!ours || !TLC.color.equal(TLC.color.parse(style.getPropertyValue('color')), TLC.color.parse(want))) {
        style.setProperty('color', want, 'important');
      }
      rec.__text = { orig, mine: style.getPropertyValue('color'), native, cls: el.className };
    } else if (prev) {
      if (style.getPropertyValue('color') === prev.mine) style.setProperty('color', prev.orig);
      delete rec.__text;
    }
  }

  function restore(root) {
    for (const el of [root, ...root.querySelectorAll('[style]')]) {
      const rec = records.get(el);
      if (!rec) continue;
      for (const [key, r] of Object.entries(rec)) {
        const prop = key === '__text' ? 'color' : key;
        if (el.style.getPropertyValue(prop) !== r.mine) continue;
        if (r.orig) el.style.setProperty(prop, r.orig);
        else el.style.removeProperty(prop);
      }
      records.delete(el);
    }
  }

  // ---------------------------------------------------------------------------
  // Fallback matching data scraped from a chip: { title, dateKey }

  const DATE_RE = /([A-Z][a-z]+\.? \d{1,2}, \d{4})/;
  const LEADING_TIME = /^\d{1,2}(:\d{2})?\s?([ap]\.?m\.?)?\s*[,–-]?\s*/i;
  const pad = (n) => String(n).padStart(2, '0');

  function info(chip) {
    let title = '';
    const cell = chip.querySelector('[role="button"][data-eventid]'); // schedule view
    if (cell) title = cell.textContent.trim();
    if (!title) {
      for (const span of chip.querySelectorAll('[aria-hidden="true"]')) {
        if (span.closest('button')) continue;
        const t = span.textContent.trim();
        if (t) {
          title = t;
          break;
        }
      }
    }
    if (title && TLC.store.data && !(title in TLC.store.data.byTitle)) title = title.replace(LEADING_TIME, '');

    let dateKey = null;
    const texts = [chip.getAttribute('aria-label')];
    for (const e of chip.querySelectorAll('[aria-label], span')) texts.push(e.getAttribute('aria-label') || e.textContent);
    for (const t of texts) {
      const m = t && DATE_RE.exec(t);
      if (!m) continue;
      const d = new Date(m[1]);
      if (!isNaN(d)) {
        dateKey = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        break;
      }
    }
    return { title, dateKey };
  }

  // The "Task list: <name>" row in the task details popup. Its icon ligature
  // ("list_alt") is not translated, so this works in every UI language.
  function dialogListTitle(root) {
    const icon = [...root.querySelectorAll('i')].find((i) => i.textContent.trim() === 'list_alt');
    const row = icon && (icon.closest('[role="button"]') || icon.parentElement?.parentElement);
    if (!row) return null;
    const label = [...row.children].find((c) => !c.contains(icon));
    if (!label) return null;
    const direct = [...label.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim();
    return direct || null;
  }

  // ---------------------------------------------------------------------------

  function processChip(chip, base) {
    const taskId = chip.getAttribute('data-eventid').slice('tasks_'.length);
    const listId = TLC.store.listFor(taskId, () => info(chip));
    if (!listId) {
      chip.toggleAttribute('data-tlc-hidden', false);
      restore(chip);
      if (TLC.store.data) unknown.add(taskId);
      return;
    }
    chip.toggleAttribute('data-tlc-hidden', TLC.store.isHidden(listId));
    const color = TLC.color.parse(TLC.store.colorOf(listId));
    if (color && base) paint(chip, base, color);
    else restore(chip);
  }

  function processDialog(el, base) {
    const taskId = el.getAttribute('data-taskid');
    if (!taskId) return false;
    const title = dialogListTitle(el);
    if (title && TLC.store.listIdByTitle(title)) TLC.store.learn(taskId, title);
    const listId = TLC.store.listFor(taskId);
    const color = listId && TLC.color.parse(TLC.store.colorOf(listId));
    if (color && base) paint(el, base, color, { text: false });
    else restore(el);
    return true;
  }

  return {
    // Returns true while a task details popup is open.
    processAll(base) {
      for (const chip of document.querySelectorAll(CHIP)) processChip(chip, base);
      let dialogOpen = false;
      for (const el of document.querySelectorAll(DIALOG_TASK)) dialogOpen = processDialog(el, base) || dialogOpen;
      return dialogOpen;
    },
    restoreAll() {
      for (const el of document.querySelectorAll(`${CHIP}, ${DIALOG_TASK}`)) {
        el.removeAttribute('data-tlc-hidden');
        restore(el);
      }
    },
    takeUnknown() {
      const ids = [...unknown];
      unknown.clear();
      return ids;
    },
  };
})();
