'use strict';

const KEY = { clientId: 'tlc:clientId', status: 'tlc:status', data: 'tlc:data' };
const CLIENT_ID_RE = /^[\w-]+\.apps\.googleusercontent\.com$/;

const $ = (id) => document.getElementById(id);
const ui = {
  dot: $('status-dot'),
  title: $('status-title'),
  detail: $('status-detail'),
  connect: $('connect'),
  refresh: $('refresh'),
  disconnect: $('disconnect'),
  hint: $('usage-hint'),
  setup: $('setup'),
  setupState: $('setup-state'),
  redirect: $('redirect-uri'),
  copy: $('copy-redirect'),
  form: $('client-form'),
  clientId: $('client-id'),
  save: $('save-client'),
  error: $('client-error'),
};

let state = { clientId: '', status: null, data: null };
let busy = null;

function ago(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  return rtf.format(-Math.round(s / 86400), 'day');
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function render() {
  const { clientId, status, data } = state;
  const s = !clientId ? 'setup' : status?.state || 'loading';
  ui.dot.dataset.state = s;

  const show = { connect: false, refresh: false, disconnect: false };
  let title = '';
  let detail = '';
  switch (s) {
    case 'setup':
      title = 'Finish setup to get started';
      detail = 'Add your OAuth client ID under Google Cloud setup below.';
      break;
    case 'signin':
      title = data ? 'Reconnect needed' : 'Not connected';
      detail = data
        ? 'Google needs you to sign in again to keep task lists up to date.'
        : 'Connect the Google account you use in Calendar so its task lists can be read.';
      show.connect = true;
      show.disconnect = !!data;
      break;
    case 'ok': {
      title = 'Connected';
      const parts = [];
      if (status.account) parts.push(status.account);
      if (data?.lists) parts.push(plural(data.lists.length, 'list'));
      if (typeof status.tasks === 'number') parts.push(plural(status.tasks, 'dated task'));
      parts.push(`updated ${ago(data?.updated || status.at)}`);
      detail = parts.join(' · ');
      show.refresh = true;
      show.disconnect = true;
      break;
    }
    case 'error':
      title = "Couldn't load task lists";
      detail = status.message || 'Something went wrong.';
      show.refresh = true;
      show.connect = true;
      break;
    default:
      title = 'Checking connection…';
  }
  ui.title.textContent = title;
  ui.detail.textContent = detail;

  ui.connect.hidden = !show.connect;
  ui.refresh.hidden = !show.refresh;
  ui.disconnect.hidden = !show.disconnect;
  ui.connect.textContent = busy === 'connect' ? 'Connecting…' : s === 'signin' && data ? 'Reconnect' : 'Connect Google Tasks';
  ui.refresh.textContent = busy === 'refresh' ? 'Refreshing…' : s === 'error' ? 'Try again' : 'Refresh now';
  for (const b of [ui.connect, ui.refresh, ui.disconnect]) b.disabled = !!busy;
  ui.hint.hidden = s !== 'ok';

  ui.setupState.textContent = clientId ? 'Client ID saved' : 'Required';
  if (document.activeElement !== ui.clientId && !ui.clientId.dataset.dirty) ui.clientId.value = clientId;
}

async function load() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(KEY.clientId),
    chrome.storage.local.get([KEY.status, KEY.data]),
  ]);
  state = { clientId: sync[KEY.clientId] || '', status: local[KEY.status] || null, data: local[KEY.data] || null };
  ui.setup.open = !state.clientId;
  render();
}

async function act(type) {
  busy = type;
  render();
  const res = await chrome.runtime.sendMessage({ type }).catch((err) => ({ ok: false, error: String(err.message || err) }));
  busy = null;
  render();
  if (res && !res.ok && res.error) {
    state.status = { state: 'error', message: res.error };
    render();
  }
}

ui.connect.addEventListener('click', () => act('connect'));
ui.refresh.addEventListener('click', () => act('refresh'));
ui.disconnect.addEventListener('click', () => act('disconnect'));

ui.redirect.textContent = chrome.identity.getRedirectURL();
ui.copy.addEventListener('click', async () => {
  await navigator.clipboard.writeText(ui.redirect.textContent);
  ui.copy.textContent = 'Copied';
  setTimeout(() => (ui.copy.textContent = 'Copy'), 1500);
});

ui.clientId.addEventListener('input', () => {
  ui.clientId.dataset.dirty = '1';
  ui.error.hidden = true;
});

ui.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = ui.clientId.value.trim();
  if (value && !CLIENT_ID_RE.test(value)) {
    ui.error.textContent = 'That doesn’t look like an OAuth client ID. It should end in .apps.googleusercontent.com.';
    ui.error.hidden = false;
    return;
  }
  delete ui.clientId.dataset.dirty;
  if (value) await chrome.storage.sync.set({ [KEY.clientId]: value });
  else await chrome.storage.sync.remove(KEY.clientId);
  ui.save.textContent = 'Saved';
  setTimeout(() => (ui.save.textContent = 'Save'), 1500);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes[KEY.clientId]) state.clientId = changes[KEY.clientId].newValue || '';
  if (area === 'local' && changes[KEY.status]) state.status = changes[KEY.status].newValue || null;
  if (area === 'local' && changes[KEY.data]) state.data = changes[KEY.data].newValue || null;
  render();
});

setInterval(render, 30_000); // keep "updated x minutes ago" fresh
load();
