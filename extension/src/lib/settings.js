export const QUALITY_PRESETS = [
  { id: 'low', label: 'Low · 64 kbit/s', bitrate: 64000 },
  { id: 'standard', label: 'Standard · 96 kbit/s', bitrate: 96000 },
  { id: 'high', label: 'High · 128 kbit/s', bitrate: 128000 },
  { id: 'max', label: 'Max · 160 kbit/s', bitrate: 160000 },
];

export const DEFAULT_SETTINGS = Object.freeze({
  serverUrl: 'http://localhost:8787',
  accessToken: '',
  bitrate: 128000,
  bufferMs: 400,
  autoReconnect: true,
  channelId: '',
  monitor: true,
  monitorVolume: 1,
  silenceHoldMs: 1500,
});

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

/** A random ID for this browser profile, so the server can recognise reconnects. */
export async function getClientId() {
  const { clientId } = await chrome.storage.local.get('clientId');
  if (clientId) return clientId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ clientId: id });
  return id;
}

/** "Artist - Track | SoundCloud" style titles -> cleaner display. */
export function sourceFromTab(tab) {
  let site = '';
  try {
    site = new URL(tab.url ?? '').hostname.replace(/^www\./, '');
  } catch {}
  return {
    title: (tab.title ?? '').slice(0, 300),
    site: site.slice(0, 200),
    url: (tab.url ?? '').slice(0, 2000),
    favIconUrl: /^https?:\/\//.test(tab.favIconUrl ?? '') ? tab.favIconUrl.slice(0, 2000) : undefined,
    audible: !!tab.audible,
  };
}

export function isCapturableUrl(url) {
  return /^(https?|file):/.test(url ?? '') && !/^https:\/\/chrome(webstore)?\.google\.com/.test(url ?? '');
}
