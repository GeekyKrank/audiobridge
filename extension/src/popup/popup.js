import { DEFAULT_SETTINGS, QUALITY_PRESETS, isCapturableUrl, loadSettings, saveSettings } from '../lib/settings.js';

const $ = (id) => document.getElementById(id);
const STATUS_POLL_MS = 3000;

let settings = { ...DEFAULT_SETTINGS };
let selectedTabId = null;
let apiStatus = null;
let session = { share: null, live: null, lastError: null };
let prevServerStats = null;
let quality = '—';
let pollTimer = null;

// ---------------- helpers ----------------

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (v !== undefined && v !== null) e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) e.append(c);
  return e;
}

const bg = (msg) => chrome.runtime.sendMessage({ to: 'bg', ...msg });

async function api(path, { method = 'GET', body, url = settings.serverUrl, token = settings.accessToken } = {}) {
  const res = await fetch(new URL(path, url.replace(/\/+$/, '') + '/'), {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      res.status === 401 ? 'Wrong access token.'
      : res.status === 403 ? 'Server refused this extension (check EXTENSION_ID on the server).'
      : res.status === 429 ? 'Too many failed attempts. Wait 10 minutes.'
      : data.message || `Server error ${res.status}`;
    throw Object.assign(new Error(msg), { status: res.status });
  }
  return data;
}

function showHint(text, kind = 'error', action = null) {
  const h = $('hint');
  if (!text) {
    h.hidden = true;
    return;
  }
  h.className = `hint ${kind === 'info' ? 'info' : ''}`;
  h.replaceChildren(el('div', { text }));
  if (action) {
    const b = el('button', { class: 'btn ghost', text: action.label });
    b.addEventListener('click', action.run);
    h.append(b);
  }
  h.hidden = false;
}

// ---------------- tabs ----------------

function tabRow(tab, { selected = false, live = false } = {}) {
  let site = '';
  try {
    site = new URL(tab.url).hostname.replace(/^www\./, '');
  } catch {}
  const fav = tab.favIconUrl && /^https?:|^data:image\//.test(tab.favIconUrl)
    ? el('img', { src: tab.favIconUrl, alt: '' })
    : el('div', { class: 'fav' });
  const right = live
    ? el('span', { class: 'tag live', text: session.live?.audible === false ? 'Paused' : 'Sharing' })
    : tab.audible
      ? el('span', { class: 'audible', title: 'Playing audio' }, [el('i'), el('i'), el('i')])
      : selected ? el('span', { class: 'tag', text: 'Selected' }) : null;
  return el('div', { class: `tab-row${selected ? ' selected' : ''}`, 'data-tab': String(tab.id) }, [
    fav,
    el('div', { style: 'min-width:0' }, [
      el('div', { class: 'tab-title', text: tab.title || 'Untitled', title: tab.title || '' }),
      el('div', { class: 'tab-site', text: site }),
    ]),
    right,
  ]);
}

async function renderTabs() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const all = (await chrome.tabs.query({})).filter((t) => isCapturableUrl(t.url));
  const sharedId = session.share?.tabId ?? null;
  if (sharedId) selectedTabId = sharedId;
  if (selectedTabId === null || !all.some((t) => t.id === selectedTabId)) {
    selectedTabId = active && isCapturableUrl(active.url) ? active.id : (all.find((t) => t.audible) ?? all[0])?.id ?? null;
  }

  const selected = all.find((t) => t.id === selectedTabId);
  const src = $('source');
  if (selected) {
    src.replaceWith(Object.assign(tabRow(selected, { selected: true, live: sharedId === selected.id }), { id: 'source' }));
  } else {
    src.replaceChildren(el('div', { class: 'muted', text: 'Open a website that plays audio.' }));
  }

  const others = all
    .filter((t) => t.id !== selectedTabId)
    .sort((a, b) => Number(b.audible) - Number(a.audible) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  const audibleCount = others.filter((t) => t.audible).length;
  $('other-count').textContent = others.length
    ? `Other tabs (${others.length}${audibleCount ? `, ${audibleCount} playing` : ''})`
    : 'No other tabs';
  const list = $('tab-list');
  list.replaceChildren(
    ...others.map((t) => {
      const li = el('li', {}, [tabRow(t)]);
      li.addEventListener('click', () => {
        if (session.share) return showHint('Stop sharing first to switch tabs.', 'info');
        selectedTabId = t.id;
        $('other-tabs').open = false;
        renderTabs();
      });
      return li;
    }),
  );
}

// ---------------- server / discord ----------------

function setConn(state, label) {
  const p = $('conn');
  p.dataset.state = state;
  p.querySelector('b').textContent = label;
}

async function refreshServer() {
  if (!settings.accessToken) {
    setConn('offline', 'Not set up');
    return;
  }
  try {
    apiStatus = await api('/api/status');
    setConn('connected', 'Connected');
  } catch (e) {
    apiStatus = null;
    setConn(e.status ? 'error' : 'offline', e.status ? 'Error' : 'Offline');
    if (!session.share) showHint(e.status ? e.message : `Can't reach ${settings.serverUrl}. Is the server running?`);
  }
  renderDiscord();
}

function renderDiscord() {
  const bot = apiStatus?.bot;
  $('bot-dot').className = `dot ${bot?.ready ? 'ok' : apiStatus ? 'err' : ''}`;
  $('bot-name').textContent = bot?.ready ? bot.tag : apiStatus ? 'Bot not connected to Discord' : 'Server unreachable';
  const voice = apiStatus?.voice;
  $('bot-guild').textContent = bot?.guild
    ? `${bot.guild.name}${voice ? ` · 🔊 ${voice.channelName}` : ' · not in voice'}`
    : '—';

  const sel = $('channel');
  const want = settings.channelId || '';
  const opts = [el('option', { value: '', text: 'Auto (your current channel)' })];
  for (const c of apiStatus?.channels ?? []) {
    opts.push(el('option', { value: c.id, text: `🔊 ${c.name}${c.members ? ` · ${c.members} online` : ''}` }));
  }
  if (want && !(apiStatus?.channels ?? []).some((c) => c.id === want)) {
    opts.push(el('option', { value: want, text: 'Saved channel' }));
  }
  sel.replaceChildren(...opts);
  sel.value = want;
  sel.disabled = !apiStatus;

  const vb = $('voice-btn');
  vb.textContent = voice ? 'Leave' : 'Join';
  vb.disabled = !bot?.ready || (!voice && !sel.value);
  vb.title = !voice && !sel.value ? 'Pick a channel to join' : '';
}

// ---------------- sharing ----------------

function renderShare() {
  const btn = $('share');
  const label = $('share-label');
  const { share, live } = session;
  const st = live?.state;

  if (!share) {
    btn.dataset.state = 'idle';
    label.textContent = 'Share Audio';
    btn.disabled = !selectedTabId;
  } else if (st === 'live') {
    btn.dataset.state = live.audible ? 'live' : 'paused';
    label.textContent = 'Stop Sharing';
    btn.disabled = false;
  } else {
    btn.dataset.state = 'busy';
    label.textContent = st === 'reconnecting' ? 'Reconnecting' : st === 'starting' ? 'Joining voice' : 'Connecting';
    btn.disabled = false;
  }

  // Stats
  const statusText = !share
    ? 'Idle'
    : st === 'live' ? (live.audible ? 'Live' : 'Paused')
    : st === 'reconnecting' ? 'Reconnecting'
    : 'Starting';
  $('st-status').textContent = statusText;

  const srv = live?.server;
  if (share && st === 'live') {
    const delayMs = (live.rttMs ?? 0) / 2 + (srv?.bufferMs ?? settings.bufferMs) + 20 + 100;
    $('st-delay').textContent = `~${(delayMs / 1000).toFixed(1)} s`;
    $('st-delay').title = `Network RTT ${live.rttMs ?? '?'} ms · server buffer ${srv?.bufferMs ?? '?'} ms`;
    $('st-bitrate').textContent = srv && live.audible ? `${srv.kbps} kbit/s` : `${Math.round(live.bitrate / 1000)}k`;
    $('st-quality').textContent = quality;
  } else {
    $('st-delay').textContent = '—';
    $('st-bitrate').textContent = `${Math.round(settings.bitrate / 1000)}k`;
    $('st-quality').textContent = '—';
  }

  if (share && live?.state === 'reconnecting' && live.error) showHint(live.error, 'info');
  else if (share && st === 'live' && live.channel) showHint(null);
}

function updateQuality(live) {
  const s = live?.server;
  if (!s) return;
  const p = prevServerStats;
  prevServerStats = s;
  const newStalls = p ? s.underruns - p.underruns + (s.sequenceGaps - p.sequenceGaps) : 0;
  const rtt = live.rttMs ?? 999;
  quality = newStalls > 2 || rtt > 400 ? 'Poor' : newStalls > 0 || rtt > 150 ? 'Fair' : rtt > 70 ? 'Good' : 'Excellent';
}

async function onShareClick() {
  showHint(null);
  if (session.share) {
    $('share').disabled = true;
    await bg({ cmd: 'stop' });
    return;
  }
  if (!settings.accessToken) {
    openSettings();
    return;
  }
  if (!selectedTabId) return;
  $('share').dataset.state = 'busy';
  $('share-label').textContent = 'Starting';
  const r = await bg({ cmd: 'share', tabId: selectedTabId });
  if (!r?.ok) {
    renderShare();
    if (r?.code === 'needs-invoke') {
      showHint(
        'Chrome only lets SoundBridge capture a tab after you open SoundBridge on that tab. Switch to it, then click the SoundBridge icon (or press Alt+Shift+S there).',
        'info',
        {
          label: 'Go to that tab',
          run: async () => {
            const t = await chrome.tabs.update(r.tabId, { active: true });
            await chrome.windows.update(t.windowId, { focused: true });
            window.close();
          },
        },
      );
    } else if (r?.code === 'no-settings') {
      openSettings();
    } else {
      showHint(r?.error ?? 'Could not start sharing.');
    }
  }
}

async function onVoiceClick() {
  const btn = $('voice-btn');
  btn.disabled = true;
  try {
    if (apiStatus?.voice) await api('/api/voice/leave', { method: 'POST' });
    else await api('/api/voice/join', { method: 'POST', body: { channelId: $('channel').value } });
    showHint(null);
  } catch (e) {
    showHint(e.message);
  }
  await refreshServer();
}

// ---------------- settings ----------------

function fillSettingsForm() {
  const f = $('settings-form');
  f.serverUrl.value = settings.serverUrl;
  f.accessToken.value = settings.accessToken;
  $('bitrate').replaceChildren(...QUALITY_PRESETS.map((p) => el('option', { value: String(p.bitrate), text: p.label })));
  f.bitrate.value = String(settings.bitrate);
  f.bufferMs.value = String(settings.bufferMs);
  f.autoReconnect.checked = settings.autoReconnect;
  f.monitor.checked = settings.monitor;
  f.monitorVolume.value = String(settings.monitorVolume);
  syncOutputs();
}

function syncOutputs() {
  const f = $('settings-form');
  $('buffer-out').textContent = `${f.bufferMs.value} ms`;
  $('vol-out').textContent = `${Math.round(Number(f.monitorVolume.value) * 100)}%`;
  f.monitorVolume.disabled = !f.monitor.checked;
}

function readForm() {
  const f = $('settings-form');
  return {
    serverUrl: f.serverUrl.value.trim().replace(/\/+$/, ''),
    accessToken: f.accessToken.value.trim(),
    bitrate: Number(f.bitrate.value),
    bufferMs: Number(f.bufferMs.value),
    autoReconnect: f.autoReconnect.checked,
    monitor: f.monitor.checked,
    monitorVolume: Number(f.monitorVolume.value),
  };
}

function settingsMsg(text, ok) {
  const m = $('settings-msg');
  m.textContent = text;
  m.className = `hint ${ok ? 'info' : ''}`;
  m.hidden = !text;
}

function openSettings() {
  fillSettingsForm();
  settingsMsg('', true);
  $('view-main').hidden = true;
  $('view-settings').hidden = false;
}

function closeSettings() {
  $('view-settings').hidden = true;
  $('view-main').hidden = false;
}

// ---------------- wiring ----------------

async function loadSession() {
  session = { share: null, live: null, lastError: null, ...(await chrome.storage.session.get(['share', 'live', 'lastError'])) };
}

async function init() {
  settings = await loadSettings();
  await loadSession();
  await renderTabs();
  renderShare();
  renderDiscord();
  if (session.lastError && !session.share) showHint(session.lastError);

  if (!settings.accessToken) {
    openSettings();
    settingsMsg('Welcome! Enter your SoundBridge server URL and the ACCESS_TOKEN from server/.env.', true);
  }
  refreshServer();
  pollTimer = setInterval(refreshServer, STATUS_POLL_MS);

  $('share').addEventListener('click', onShareClick);
  $('voice-btn').addEventListener('click', onVoiceClick);
  $('channel').addEventListener('change', async (e) => {
    settings = await saveSettings({ channelId: e.target.value });
    renderDiscord();
  });
  $('open-settings').addEventListener('click', openSettings);
  $('close-settings').addEventListener('click', closeSettings);

  const form = $('settings-form');
  form.addEventListener('input', () => {
    syncOutputs();
    const v = readForm();
    // Monitoring changes apply live.
    bg({ cmd: 'monitor', monitor: v.monitor, monitorVolume: v.monitorVolume }).catch(() => {});
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = readForm();
    try {
      new URL(v.serverUrl);
    } catch {
      return settingsMsg('Server URL is not valid.', false);
    }
    if (!/^https:\/\//.test(v.serverUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(v.serverUrl)) {
      return settingsMsg('Use https:// for remote servers (http:// only for localhost).', false);
    }
    settings = await saveSettings(v);
    settingsMsg('Saved.', true);
    await refreshServer();
    setTimeout(closeSettings, 400);
  });
  $('test-conn').addEventListener('click', async () => {
    const v = readForm();
    settingsMsg('Testing…', true);
    try {
      const s = await api('/api/status', { url: v.serverUrl, token: v.accessToken });
      settingsMsg(
        `✓ Connected to server ${s.serverVersion}. Bot: ${s.bot.ready ? `${s.bot.tag} in ${s.bot.guild?.name ?? '?'}` : 'not connected to Discord'}.`,
        true,
      );
    } catch (e) {
      settingsMsg(e.status ? e.message : `Can't reach ${v.serverUrl}: ${e.message}`, false);
    }
  });

  chrome.storage.session.onChanged.addListener(async (changes) => {
    if ('share' in changes) session.share = changes.share.newValue ?? null;
    if ('live' in changes) {
      session.live = changes.live.newValue ?? null;
      updateQuality(session.live);
    }
    if ('lastError' in changes) {
      session.lastError = changes.lastError.newValue ?? null;
      if (session.lastError && !session.share) showHint(session.lastError);
    }
    if ('share' in changes) await renderTabs();
    renderShare();
  });
  chrome.tabs.onUpdated.addListener((_id, change) => {
    if ('title' in change || 'audible' in change || 'favIconUrl' in change) renderTabs();
  });
  chrome.tabs.onRemoved.addListener(() => renderTabs());
}

window.addEventListener('unload', () => clearInterval(pollTimer));
init();
