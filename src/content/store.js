'use strict';

// State shared by the content scripts, backed by chrome.storage.
//   sync  tlc:prefs    { colors: {listId: '#RRGGBB'}, hidden: {listId: true} }
//   sync  tlc:clientId OAuth client ID (presence = configured)
//   local tlc:data     task -> list index written by the background worker
//   local tlc:status   connection state written by the background worker
//   local tlc:learned  { taskId: {t: listTitle, at} } read from task details popups

TLC.store = (() => {
  const K = { prefs: 'tlc:prefs', clientId: 'tlc:clientId', data: 'tlc:data', status: 'tlc:status', learned: 'tlc:learned' };
  const MAX_LEARNED = 2000;

  const state = {
    prefs: { colors: {}, hidden: {} },
    configured: false,
    data: null,
    status: { state: 'loading' },
    learned: {},
  };
  const listeners = new Set();
  let listIds = new Set();
  let titleIndex = null;
  let inflightWrites = 0;

  const normalizePrefs = (p) => ({ colors: { ...(p?.colors || {}) }, hidden: { ...(p?.hidden || {}) } });

  function setData(data) {
    state.data = data || null;
    listIds = new Set((state.data?.lists || []).map((l) => l.id));
    titleIndex = null;
  }

  function emit() {
    for (const fn of listeners) {
      try {
        fn();
      } catch (err) {
        console.error('[Task List Colors]', err);
      }
    }
  }

  async function init() {
    const [sync, local] = await Promise.all([
      chrome.storage.sync.get([K.prefs, K.clientId]),
      chrome.storage.local.get([K.data, K.status, K.learned]),
    ]);
    state.prefs = normalizePrefs(sync[K.prefs]);
    state.configured = !!sync[K.clientId];
    setData(local[K.data]);
    state.status = local[K.status] || { state: state.configured ? 'loading' : 'setup' };
    state.learned = local[K.learned] || {};
    chrome.storage.onChanged.addListener(onChanged);
  }

  function onChanged(changes, area) {
    if (!TLC.alive()) return;
    let changed = false;
    if (area === 'sync') {
      // While our own writes are in flight, their echoes would briefly undo newer local changes.
      if (changes[K.prefs] && inflightWrites === 0) {
        state.prefs = normalizePrefs(changes[K.prefs].newValue);
        changed = true;
      }
      if (changes[K.clientId]) {
        state.configured = !!changes[K.clientId].newValue;
        changed = true;
      }
    } else if (area === 'local') {
      if (changes[K.data]) {
        setData(changes[K.data].newValue);
        changed = true;
      }
      if (changes[K.status]) {
        state.status = changes[K.status].newValue || { state: 'loading' };
        changed = true;
      }
      if (changes[K.learned]) {
        state.learned = changes[K.learned].newValue || {};
        changed = true;
      }
    }
    if (changed) emit();
  }

  async function writePrefs(next) {
    state.prefs = next;
    emit();
    if (!TLC.alive()) return;
    inflightWrites++;
    try {
      await chrome.storage.sync.set({ [K.prefs]: next });
    } catch (err) {
      console.warn('[Task List Colors] could not save preferences:', err);
    } finally {
      inflightWrites--;
    }
  }

  function listIdByTitle(title) {
    if (!titleIndex) {
      titleIndex = new Map();
      for (const l of state.data?.lists || []) titleIndex.set(l.title, titleIndex.has(l.title) ? null : l.id);
    }
    return titleIndex.get(title) || null;
  }

  // Which list does a calendar task belong to? `info` lazily returns
  // { title, dateKey } scraped from the chip, used only as a fallback.
  function listFor(taskId, info) {
    const d = state.data;
    if (!d) return null;
    const learned = state.learned[taskId];
    const learnedId = learned ? listIdByTitle(learned.t) : null;
    if (learnedId && learned.at > d.updated) return learnedId;
    const direct = d.byId[taskId];
    if (direct && listIds.has(direct)) return direct;
    if (learnedId) return learnedId;

    const i = info?.();
    if (!i?.title) return null;
    if (i.dateKey) {
      const v = d.byTitleDate[`${i.title}\u0001${i.dateKey}`];
      if (v === null) return null; // same title and date in several lists
      if (v && listIds.has(v)) return v;
    }
    const t = d.byTitle[i.title];
    return t && listIds.has(t) ? t : null;
  }

  async function learn(taskId, listTitle) {
    const prev = state.learned[taskId];
    if (prev && prev.t === listTitle && Date.now() - prev.at < 60_000) return;
    const next = { ...state.learned, [taskId]: { t: listTitle, at: Date.now() } };
    const keys = Object.keys(next);
    if (keys.length > MAX_LEARNED) {
      keys.sort((a, b) => next[a].at - next[b].at);
      for (const k of keys.slice(0, keys.length - MAX_LEARNED)) delete next[k];
    }
    state.learned = next;
    emit();
    if (TLC.alive()) await chrome.storage.local.set({ [K.learned]: next }).catch(() => {});
  }

  // Give every list a stable color. The first (default) list keeps the
  // native Tasks color; the rest get distinct palette colors.
  function ensureColors(baseHex) {
    const lists = state.data?.lists || [];
    if (!lists.length) return;
    const colors = { ...state.prefs.colors };
    let changed = false;
    for (const id of Object.keys(colors)) {
      if (!listIds.has(id)) {
        delete colors[id];
        changed = true;
      }
    }
    const used = new Set(Object.values(colors).map((c) => c.toUpperCase()));
    const base = baseHex?.toUpperCase();
    lists.forEach((list, i) => {
      if (colors[list.id]) return;
      let pick;
      if (i === 0 && base && !used.has(base)) pick = base;
      else pick = TLC.AUTO_COLORS.find((c) => !used.has(c) && c !== base) || TLC.AUTO_COLORS[i % TLC.AUTO_COLORS.length];
      colors[list.id] = pick;
      used.add(pick);
      changed = true;
    });
    const hidden = { ...state.prefs.hidden };
    for (const id of Object.keys(hidden)) {
      if (!listIds.has(id)) {
        delete hidden[id];
        changed = true;
      }
    }
    if (changed) writePrefs({ colors, hidden });
  }

  return {
    init,
    onChange: (fn) => listeners.add(fn),
    get configured() {
      return state.configured;
    },
    get status() {
      return state.status;
    },
    get data() {
      return state.data;
    },
    lists: () => state.data?.lists || [],
    colorOf: (listId) => state.prefs.colors[listId] || null,
    isHidden: (listId) => !!state.prefs.hidden[listId],
    setColor: (listId, hex) =>
      writePrefs({ ...state.prefs, colors: { ...state.prefs.colors, [listId]: hex.toUpperCase() } }),
    // Show a color without saving it (live preview while the color picker is open).
    previewColor(listId, hex) {
      state.prefs = { ...state.prefs, colors: { ...state.prefs.colors, [listId]: hex.toUpperCase() } };
      emit();
    },
    setHidden(listId, hidden) {
      const next = { ...state.prefs.hidden };
      if (hidden) next[listId] = true;
      else delete next[listId];
      return writePrefs({ ...state.prefs, hidden: next });
    },
    showOnly(listId) {
      const hidden = {};
      for (const l of state.data?.lists || []) if (l.id !== listId) hidden[l.id] = true;
      return writePrefs({ ...state.prefs, hidden });
    },
    showAll: () => writePrefs({ ...state.prefs, hidden: {} }),
    ensureColors,
    listFor,
    listIdByTitle,
    learn,
  };
})();
