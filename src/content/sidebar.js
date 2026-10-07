'use strict';

// Adds one row per task list under "My calendars", right below the native
// "Tasks" calendar. Rows are clones of Calendar's own "Tasks" row with its
// script hooks removed, so they pick up whatever styling Calendar currently
// ships (density, theme, hover states) without copying any of its CSS.

TLC.sidebar = (() => {
  const TASKS_DATA_ID = 'dGFza3NAdGFza3MuZ29vZ2xlLmNvbQ'; // base64("tasks@tasks.google.com")
  const STRIP = new Set([
    'id', 'data-id', 'data-text', 'data-tooltip-id', 'data-tooltip-enabled', 'data-focus-id', 'data-tab-target',
    'data-sync-idom-state', 'aria-posinset', 'aria-setsize', 'aria-describedby', 'aria-labelledby',
  ]);

  let block = null;
  let signature = '';
  let busy = null; // action currently in progress, e.g. 'connect'

  const tasksRow = () => document.querySelector(`[data-id="${TASKS_DATA_ID}"]`);

  function nativeBase() {
    const box = tasksRow()?.querySelector('[style*="--checkbox-color"]');
    return box ? TLC.color.parse(box.style.getPropertyValue('--checkbox-color').trim()) : null;
  }

  function tasksEnabled() {
    const input = tasksRow()?.querySelector('input[type="checkbox"]');
    return input ? input.checked : true;
  }

  function sectionExpanded(list) {
    for (let el = list; el && el !== document.body; el = el.parentElement) {
      const prev = el.previousElementSibling;
      if (prev?.matches('button[aria-expanded]')) return prev.getAttribute('aria-expanded') !== 'false';
    }
    return list.getBoundingClientRect().height > 0;
  }

  // Rows in this list are absolutely positioned, so compare positions rather than DOM order.
  function tasksIsLast(row, list) {
    const top = row.getBoundingClientRect().top;
    return [...list.querySelectorAll('[data-id]')].every((r) => r.getBoundingClientRect().top <= top + 1);
  }

  // ---------------------------------------------------------------------------
  // Building rows

  function template(row) {
    const li = (row.closest('li') || row).cloneNode(true);
    for (const el of [li, ...li.querySelectorAll('*')]) {
      for (const { name } of [...el.attributes]) {
        if (name.startsWith('js') || STRIP.has(name)) el.removeAttribute(name);
      }
    }
    li.querySelectorAll('[role="tooltip"]').forEach((t) => t.remove());
    return li;
  }

  const labelElement = (li, nativeLabel) =>
    [...li.querySelectorAll('*')].find((e) => !e.children.length && e.textContent.trim() === nativeLabel) || null;

  function makeRow(tpl, nativeLabel, list, { color, visible }) {
    const li = tpl.cloneNode(true);
    li.classList.add('tlc-row');
    li.dataset.tlcList = list.id;
    li.setAttribute('role', 'listitem');

    li.querySelector('[style*="--checkbox-color"]')?.style.setProperty('--checkbox-color', color);
    const input = li.querySelector('input[type="checkbox"]');
    if (input) {
      input.checked = visible;
      input.tabIndex = 0;
      input.setAttribute('aria-label', list.title);
    }

    const label = labelElement(li, nativeLabel);
    if (label) {
      label.textContent = list.title;
      const host = label.parentElement;
      TLC.tooltip.attach(host, () => (host.scrollWidth > host.clientWidth ? list.title : ''));
    }

    const btn = li.querySelector('button');
    if (btn) {
      btn.tabIndex = 0;
      btn.setAttribute('aria-label', `Options for ${list.title}`);
      btn.setAttribute('aria-haspopup', 'menu');
      btn.setAttribute('aria-expanded', 'false');
      TLC.tooltip.attach(btn, `Options for ${list.title}`);
      const inner = li.firstElementChild;
      inner?.classList.add('tlc-row__inner');
      [...(inner?.children || [])].find((c) => c.contains(btn))?.classList.add('tlc-row__actions');
    }
    return li;
  }

  function notice(text, action, actionLabel) {
    return TLC.h(
      'div',
      { class: 'tlc-notice', role: 'listitem' },
      TLC.h('div', { class: 'tlc-notice__text' }, text),
      action
        ? TLC.h(
            'button',
            { type: 'button', class: 'tlc-text-btn', 'data-tlc-action': action, disabled: busy === action },
            busy === action ? 'Working…' : actionLabel
          )
        : null
    );
  }

  function viewState() {
    const store = TLC.store;
    const status = store.status || {};
    if (!store.configured || status.state === 'setup') return { kind: 'setup' };
    const lists = store.lists();
    if (store.data && lists.length) {
      const page = TLC.pageAccount();
      const account = store.data.account;
      return {
        kind: 'lists',
        lists: lists.map((l) => ({ id: l.id, title: l.title, color: store.colorOf(l.id), hidden: store.isHidden(l.id) })),
        mismatch: page && account && page !== account.toLowerCase() ? account : null,
        stale: status.state === 'signin',
      };
    }
    if (status.state === 'signin') return { kind: 'signin' };
    if (status.state === 'error') return { kind: 'error', message: status.message };
    return { kind: 'loading' };
  }

  function build(row, list, view) {
    const nested = tasksIsLast(row, list);
    const el = TLC.h('div', {
      class: `tlc-lists${nested ? ' tlc-lists--nested' : ''}${tasksEnabled() ? '' : ' tlc-lists--muted'}`,
      role: 'list',
      'aria-label': 'Task lists',
    });
    const labelBox = row.querySelector('[data-text]') || row.children[1];
    if (labelBox) {
      const inset = labelBox.getBoundingClientRect().left - list.getBoundingClientRect().left;
      if (inset > 0) el.style.setProperty('--tlc-label-inset', `${Math.round(inset)}px`);
    }
    if (!nested) el.append(TLC.h('div', { class: 'tlc-caption' }, 'Task lists'));

    switch (view.kind) {
      case 'setup':
        el.append(notice('Color your tasks by list', 'setup', 'Set up'));
        break;
      case 'signin':
        el.append(notice('Connect Google Tasks to color tasks by list', 'connect', 'Connect'));
        break;
      case 'error':
        el.append(notice(`Couldn't load task lists. ${view.message || ''}`.trim(), 'retry', 'Try again'));
        break;
      case 'lists': {
        if (view.mismatch) el.append(notice(`Showing lists for ${view.mismatch}`, 'connect', 'Use this account'));
        else if (view.stale) el.append(notice('Reconnect to keep task lists up to date', 'connect', 'Reconnect'));
        const tpl = template(row);
        const nativeLabel = row.querySelector('input[type="checkbox"]')?.getAttribute('aria-label') || 'Tasks';
        for (const l of view.lists) {
          el.append(makeRow(tpl, nativeLabel, l, { color: l.color || TLC.color.hex(nativeBase() || TLC.color.parse('#4285F4')), visible: !l.hidden }));
        }
        break;
      }
      default:
        return null;
    }
    wire(el);
    return el;
  }

  // ---------------------------------------------------------------------------
  // Events

  async function runAction(action) {
    if (busy) return;
    if (action === 'setup') {
      TLC.send({ type: 'openOptions' });
      return;
    }
    busy = action;
    signature = '';
    render();
    const res = await TLC.send({ type: action === 'retry' ? 'refresh' : 'connect', account: TLC.pageAccount() });
    busy = null;
    signature = '';
    render();
    if (!res.ok && res.error) console.warn('[Task List Colors]', res.error);
  }

  function wire(el) {
    // Keep Calendar's delegated handlers from reacting to our rows.
    for (const type of ['click', 'dblclick', 'contextmenu', 'keydown', 'keyup', 'keypress']) {
      el.addEventListener(type, (e) => e.stopPropagation());
    }
    el.addEventListener('click', (e) => {
      const action = e.target.closest('[data-tlc-action]');
      if (action) {
        e.preventDefault();
        runAction(action.dataset.tlcAction);
        return;
      }
      const row = e.target.closest('.tlc-row');
      if (!row) return;
      const id = row.dataset.tlcList;
      const btn = e.target.closest('button');
      if (btn) {
        e.preventDefault();
        const title = TLC.store.lists().find((l) => l.id === id)?.title || '';
        TLC.menu.open(btn, id, title);
        return;
      }
      if (e.target.matches('input[type="checkbox"]')) return; // handled on change
      e.preventDefault();
      TLC.store.setHidden(id, !TLC.store.isHidden(id));
    });
    el.addEventListener('change', (e) => {
      const input = e.target.closest('input[type="checkbox"]');
      const row = input?.closest('.tlc-row');
      if (row) TLC.store.setHidden(row.dataset.tlcList, !input.checked);
    });
  }

  // ---------------------------------------------------------------------------

  function remove() {
    if (block?.isConnected) block.remove();
    block = null;
    signature = '';
  }

  function render() {
    const row = tasksRow();
    const list = row?.closest('[role="list"]');
    if (!row || !list || !sectionExpanded(list)) {
      if (TLC.menu.openFor) TLC.menu.close();
      remove();
      return;
    }
    const view = viewState();
    const sig = JSON.stringify([view, busy, tasksEnabled(), tasksIsLast(row, list), row.closest('li')?.className]);
    if (block?.isConnected && block.previousElementSibling === list && sig === signature) return;

    // Remember keyboard focus so rebuilding doesn't drop it.
    const active = block?.contains(document.activeElement) ? document.activeElement : null;
    const focusList = active?.closest('.tlc-row')?.dataset.tlcList;
    const focusSel = active?.matches('button') ? 'button' : 'input[type="checkbox"]';

    if (TLC.menu.openFor) TLC.menu.close();
    const next = build(row, list, view);
    signature = sig;
    if (block?.isConnected) block.remove();
    block = next;
    if (next) list.after(next);
    if (next && focusList) {
      const r = next.querySelector(`.tlc-row[data-tlc-list="${CSS.escape(focusList)}"]`);
      r?.querySelector(focusSel)?.focus();
      // The options button is only displayed once its row has focus.
      if (r && !r.contains(document.activeElement)) r.querySelector('input[type="checkbox"]')?.focus();
    }
  }

  return {
    render,
    remove,
    nativeBase,
    isOwnNode: (node) => !!block && (node === block || block.contains(node)),
    get attached() {
      return !!block?.isConnected;
    },
  };
})();
