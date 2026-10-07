'use strict';

// Bootstraps the content script: watches Calendar's DOM, re-applies colors and
// sidebar rows after every re-render, and asks the background worker to
// refresh task data at sensible moments.

(async () => {
  const BASE_KEY = 'tlc:base';
  const MINUTE = 60_000;

  await TLC.store.init();

  // Last known native Tasks color, for when the sidebar is collapsed or not yet rendered.
  let base = TLC.color.parse((await chrome.storage.local.get(BASE_KEY))[BASE_KEY]);
  let frame = 0;
  let dialogWasOpen = false;
  let hadBlock = false;
  let timer = 0;
  const lastRefresh = {};
  const triedUnknown = new Set();

  function refresh(reason, minGap) {
    const now = Date.now();
    if (now - (lastRefresh[reason] || 0) < minGap) return;
    lastRefresh[reason] = now;
    if (TLC.store.configured) TLC.send({ type: 'refresh', account: TLC.pageAccount() });
  }

  function currentBase() {
    const b = TLC.sidebar.nativeBase();
    if (b && !TLC.color.equal(b, base)) {
      base = b;
      chrome.storage.local.set({ [BASE_KEY]: TLC.color.hex(b) }).catch(() => {});
    }
    return base;
  }

  function run() {
    frame = 0;
    if (!TLC.alive()) {
      teardown();
      return;
    }
    const b = currentBase();
    if (b) TLC.store.ensureColors(TLC.color.hex(b));
    TLC.sidebar.render();
    hadBlock = TLC.sidebar.attached;

    const dialogOpen = TLC.chips.processAll(b);
    // A task can be edited or moved to another list from its details popup.
    if (dialogWasOpen && !dialogOpen) refresh('dialog', 5_000);
    dialogWasOpen = dialogOpen;

    // New tasks appear on the calendar before our data knows about them.
    const fresh = TLC.chips.takeUnknown().filter((id) => !triedUnknown.has(id));
    if (fresh.length && TLC.store.status?.state === 'ok') {
      fresh.forEach((id) => triedUnknown.add(id));
      refresh('unknown', 20_000);
    }
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(run);
  }

  const RELEVANT_ATTR_TARGET = '[data-eventid^="tasks_"], [data-id], [role="dialog"], button[aria-expanded]';
  const observer = new MutationObserver((records) => {
    let dirty = false;
    for (const m of records) {
      if (m.type === 'childList') {
        if (!TLC.sidebar.isOwnNode(m.target)) dirty = true;
      } else if (m.target.closest?.(RELEVANT_ATTR_TARGET)) {
        dirty = true;
      }
      if (dirty) break;
    }
    if (!dirty) return;
    // Calendar's renderer drops foreign nodes when it re-renders the sidebar;
    // put our rows back before the next paint so they never flicker.
    if (hadBlock && !TLC.sidebar.attached && TLC.alive()) {
      TLC.sidebar.render();
      hadBlock = TLC.sidebar.attached;
    }
    schedule();
  });

  function onVisibility() {
    if (document.visibilityState === 'visible') refresh('visible', 2 * MINUTE);
  }

  function teardown() {
    observer.disconnect();
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('change', schedule, true);
    TLC.menu.close();
    TLC.sidebar.remove();
    TLC.chips.restoreAll();
  }

  TLC.store.onChange(schedule);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'aria-expanded', 'aria-checked', 'data-eventid'],
  });
  document.addEventListener('change', schedule, true); // native "Tasks" checkbox
  document.addEventListener('visibilitychange', onVisibility);
  timer = setInterval(() => {
    if (!TLC.alive()) teardown();
    else if (document.visibilityState === 'visible') refresh('timer', 5 * MINUTE);
  }, MINUTE);

  if (Date.now() - (TLC.store.data?.updated || 0) > MINUTE) refresh('init', 0);
  lastRefresh.timer = Date.now();
  schedule();
})().catch((err) => console.error('[Task List Colors] failed to start:', err));
