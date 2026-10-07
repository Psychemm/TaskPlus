'use strict';

// Background service worker: owns the OAuth token and the Google Tasks API.
// It builds a compact "which list does this task belong to" index and stores
// it in chrome.storage.local, where the Calendar content script picks it up.

const TASKS_API = 'https://tasks.googleapis.com/tasks/v1';
const SCOPES = 'https://www.googleapis.com/auth/tasks.readonly email';
const MAX_PAGES_PER_LIST = 50; // 100 tasks per page

const KEY = {
  clientId: 'tlc:clientId', // sync
  status: 'tlc:status', // local
  data: 'tlc:data', // local
  account: 'tlc:account', // local
  bundled: 'tlc:bundledClientId', // local: last client ID taken from config.json
  token: 'tlc:token', // session
};

class AuthRequiredError extends Error {}

// tools/set-client-id.ps1 saves the client ID to config.json in the extension
// folder. Adopt it whenever that file changes; an ID entered on the options
// page still wins until config.json is edited again.
async function applyBundledClientId() {
  let clientId = '';
  try {
    const res = await fetch(chrome.runtime.getURL('config.json'), { cache: 'no-store' });
    if (!res.ok) return;
    clientId = String((await res.json()).clientId || '').trim();
  } catch {
    return; // no config.json
  }
  if (!clientId) return;
  const { [KEY.bundled]: applied } = await chrome.storage.local.get(KEY.bundled);
  if (applied === clientId) return;
  await chrome.storage.local.set({ [KEY.bundled]: clientId });
  await chrome.storage.sync.set({ [KEY.clientId]: clientId });
}

// ---------------------------------------------------------------------------
// OAuth (implicit grant through chrome.identity.launchWebAuthFlow). This works
// with any Google account the user picks, not only the Chrome profile account.

async function cachedToken() {
  const { [KEY.token]: t } = await chrome.storage.session.get(KEY.token);
  return t && t.expiresAt - 60_000 > Date.now() ? t.accessToken : null;
}

async function clearToken() {
  await chrome.storage.session.remove(KEY.token);
}

async function authorize({ interactive, loginHint }) {
  const { [KEY.clientId]: clientId } = await chrome.storage.sync.get(KEY.clientId);
  if (!clientId) throw new Error('setup');

  const params = {
    client_id: clientId,
    response_type: 'token',
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: SCOPES,
    include_granted_scopes: 'true',
  };
  if (loginHint) params.login_hint = loginHint;
  if (!interactive) params.prompt = 'none';
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams(params)}`;

  let redirect;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({
      url,
      interactive,
      abortOnLoadForNonInteractive: false,
      timeoutMsForNonInteractive: 15_000,
    });
  } catch (err) {
    if (!interactive) throw new AuthRequiredError(err.message);
    throw new Error(
      `${err.message} If Google showed an error page, check that ${chrome.identity.getRedirectURL()} ` +
        'is listed under "Authorized redirect URIs" in your OAuth client.'
    );
  }

  const result = new URLSearchParams(new URL(redirect).hash.slice(1));
  const error = result.get('error');
  if (error) {
    if (!interactive) throw new AuthRequiredError(error);
    throw new Error(error === 'access_denied' ? 'Access was not granted.' : `Google sign-in failed: ${error}`);
  }
  const accessToken = result.get('access_token');
  if (!accessToken) throw new Error('Google did not return an access token.');
  const expiresIn = Number(result.get('expires_in')) || 3600;
  await chrome.storage.session.set({
    [KEY.token]: { accessToken, expiresAt: Date.now() + expiresIn * 1000 },
  });
  return accessToken;
}

async function tokenEmail(token) {
  try {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
    if (!res.ok) return null;
    const info = await res.json();
    return info.email || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tasks API

async function api(path, token) {
  const res = await fetch(TASKS_API + path, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new AuthRequiredError('Access token expired.');
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).error?.message || '';
    } catch {}
    if (res.status === 403 && /has not been used|is disabled/i.test(detail)) {
      throw new Error('The Google Tasks API is not enabled in your Google Cloud project.');
    }
    throw new Error(`Google Tasks API error ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.json();
}

async function paged(path, token, maxPages) {
  const items = [];
  let pageToken = '';
  for (let page = 0; page < maxPages; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const body = await api(path + (pageToken ? `${sep}pageToken=${encodeURIComponent(pageToken)}` : ''), token);
    if (body.items) items.push(...body.items);
    pageToken = body.nextPageToken;
    if (!pageToken) break;
  }
  return items;
}

function b64Decode(s) {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return /^[\w-]{6,}$/.test(bin) ? bin : null;
  } catch {
    return null;
  }
}

// Every form a task id might take in Calendar's DOM. Calendar renders task chips
// as data-eventid="tasks_<id>"; depending on the task's age that id is the API
// id, its base64-decoded form, or the id in the task's webViewLink.
function idVariants(task) {
  const ids = new Set([task.id]);
  const decoded = b64Decode(task.id);
  if (decoded) ids.add(decoded);
  const m = /\/task\/([\w-]+)/.exec(task.webViewLink || '');
  if (m) {
    ids.add(m[1]);
    const d = b64Decode(m[1]);
    if (d) ids.add(d);
  }
  return ids;
}

function buildIndex(lists, tasksByList) {
  const byId = {};
  const byTitleDate = {};
  const byTitle = {};
  const claim = (map, key, listId) => {
    if (!(key in map)) map[key] = listId;
    else if (map[key] !== listId) map[key] = null; // ambiguous
  };
  let count = 0;
  for (const list of lists) {
    for (const task of tasksByList.get(list.id) || []) {
      if (!task.due || task.deleted) continue; // only dated tasks appear on the calendar
      count++;
      for (const id of idVariants(task)) byId[id] = list.id;
      const title = (task.title || '').trim();
      if (!title) continue;
      claim(byTitleDate, `${title}\u0001${task.due.slice(0, 10)}`, list.id);
      claim(byTitle, title, list.id);
    }
  }
  return { byId, byTitleDate, byTitle, count };
}

async function fetchEverything(token) {
  const lists = (await paged('/users/@me/lists?maxResults=100', token, 10)).map((l) => ({
    id: l.id,
    title: l.title || 'Untitled list',
  }));
  const fields = 'items(id,title,due,status,deleted,webViewLink),nextPageToken';
  const tasksByList = new Map();
  await Promise.all(
    lists.map(async (list) => {
      const q = `maxResults=100&showCompleted=true&showHidden=true&showAssigned=true&fields=${encodeURIComponent(fields)}`;
      tasksByList.set(list.id, await paged(`/lists/${encodeURIComponent(list.id)}/tasks?${q}`, token, MAX_PAGES_PER_LIST));
    })
  );
  return { lists, ...buildIndex(lists, tasksByList) };
}

// ---------------------------------------------------------------------------
// Refresh orchestration

async function setStatus(status) {
  await chrome.storage.local.set({ [KEY.status]: { ...status, at: Date.now() } });
}

let inflight = null;

function refresh(opts = {}) {
  if (inflight && !opts.interactive) return inflight;
  const run = doRefresh(opts).finally(() => {
    if (inflight === run) inflight = null;
  });
  inflight = run;
  return run;
}

async function doRefresh({ interactive = false, loginHint } = {}) {
  await applyBundledClientId();
  const { [KEY.clientId]: clientId } = await chrome.storage.sync.get(KEY.clientId);
  if (!clientId) {
    await setStatus({ state: 'setup' });
    return { state: 'setup' };
  }

  const { [KEY.account]: storedAccount } = await chrome.storage.local.get(KEY.account);
  const hint = interactive ? loginHint || undefined : storedAccount || loginHint || undefined;

  try {
    let token = interactive ? null : await cachedToken();
    let fresh = false;
    if (!token) {
      token = await authorize({ interactive, loginHint: hint });
      fresh = true;
    }

    let result;
    try {
      result = await fetchEverything(token);
    } catch (err) {
      // A cached token can be revoked or expire early; get a new one once.
      if (!(err instanceof AuthRequiredError) || fresh) throw err;
      await clearToken();
      token = await authorize({ interactive: false, loginHint: hint });
      result = await fetchEverything(token);
    }

    let account = storedAccount;
    if (fresh || !account) account = (await tokenEmail(token)) || hint || storedAccount || null;
    const data = {
      lists: result.lists,
      byId: result.byId,
      byTitleDate: result.byTitleDate,
      byTitle: result.byTitle,
      account,
      updated: Date.now(),
    };
    await chrome.storage.local.set({ [KEY.data]: data, [KEY.account]: account });
    const status = { state: 'ok', account, lists: result.lists.length, tasks: result.count };
    await setStatus(status);
    return status;
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      await clearToken();
      await setStatus({ state: 'signin', account: storedAccount || null });
      return { state: 'signin' };
    }
    if (err.message === 'setup') {
      await setStatus({ state: 'setup' });
      return { state: 'setup' };
    }
    console.warn('[Task List Colors] refresh failed:', err);
    await setStatus({ state: 'error', message: err.message, account: storedAccount || null });
    if (interactive) throw err;
    return { state: 'error', message: err.message };
  }
}

async function disconnect() {
  const { [KEY.token]: t } = await chrome.storage.session.get(KEY.token);
  if (t?.accessToken) {
    fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.accessToken)}`, { method: 'POST' }).catch(() => {});
  }
  await clearToken();
  await chrome.storage.local.remove([KEY.data, KEY.account]);
  const { [KEY.clientId]: clientId } = await chrome.storage.sync.get(KEY.clientId);
  await setStatus({ state: clientId ? 'signin' : 'setup' });
  return { state: clientId ? 'signin' : 'setup' };
}

// ---------------------------------------------------------------------------
// Messaging

const handlers = {
  refresh: (msg) => refresh({ loginHint: msg.account }),
  connect: (msg) => refresh({ interactive: true, loginHint: msg.account }),
  disconnect: () => disconnect(),
  openOptions: () => chrome.runtime.openOptionsPage(),
  redirectUri: () => ({ uri: chrome.identity.getRedirectURL() }),
  syncConfig: () => applyBundledClientId(),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg))
    .then(
      (result) => sendResponse({ ok: true, ...(result || {}) }),
      (err) => sendResponse({ ok: false, error: String(err?.message || err) })
    );
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes[KEY.clientId]) {
    // A new client ID invalidates the old token and data.
    clearToken().then(() => chrome.storage.local.remove([KEY.data, KEY.account])).then(() => refresh());
  }
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await applyBundledClientId();
  const { [KEY.clientId]: clientId } = await chrome.storage.sync.get(KEY.clientId);
  if (!clientId) await setStatus({ state: 'setup' });
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

applyBundledClientId();
