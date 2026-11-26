// Service worker: orchestrates sharing. Holds no audio; it can be suspended at
// any time, so all state lives in chrome.storage.session.

import { getClientId, isCapturableUrl, loadSettings, sourceFromTab } from './lib/settings.js';

const OFFSCREEN_URL = 'src/offscreen.html';

// ---------- state ----------

/** @returns {Promise<{ tabId: number, source: object, startedAt: number } | null>} */
async function getShare() {
  const { share } = await chrome.storage.session.get('share');
  return share ?? null;
}

async function setShare(share, live = null, lastError = undefined) {
  const patch = { share, live };
  if (lastError !== undefined) patch.lastError = lastError;
  await chrome.storage.session.set(patch);
  await updateBadge(share, live);
}

async function updateBadge(share, live) {
  if (!share) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  const ok = live?.state === 'live';
  await chrome.action.setBadgeBackgroundColor({ color: ok ? '#7c5cff' : '#f59e0b' });
  await chrome.action.setBadgeText({ text: ok ? (live.audible ? 'ON' : '❚❚') : '…' });
}

// ---------- offscreen document ----------

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

let creating = null;
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA'],
      justification: 'Capture the selected tab audio, encode it and stream it to the SoundBridge server.',
    })
    .finally(() => (creating = null));
  await creating;
}

async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => {});
}

const toOffscreen = (msg) => chrome.runtime.sendMessage({ to: 'offscreen', ...msg });

// ---------- actions ----------

async function startShare(tabId) {
  const settings = await loadSettings();
  if (!settings.accessToken) {
    return { ok: false, code: 'no-settings', error: 'Open Settings and enter your server URL and access token first.' };
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { ok: false, error: 'That tab no longer exists.' };
  if (!isCapturableUrl(tab.url)) {
    return { ok: false, error: 'Chrome does not allow capturing this page (chrome://, Web Store, etc.).' };
  }

  const current = await getShare();
  if (current) await stopShare('switching tabs');

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (e) {
    const message = String(e?.message ?? e);
    if (/active stream/i.test(message)) {
      return { ok: false, error: 'This tab is already being captured (by SoundBridge or another extension).' };
    }
    // Chrome only allows capturing a tab after the user invoked the extension on it.
    return {
      ok: false,
      code: 'needs-invoke',
      tabId,
      error: 'Chrome needs you to open SoundBridge on that tab first.',
    };
  }

  await ensureOffscreen();
  const source = sourceFromTab(tab);
  const share = { tabId, source, startedAt: Date.now() };
  await setShare(share, { state: 'connecting' }, null);

  const r = await toOffscreen({ cmd: 'start', streamId, settings, source, clientId: await getClientId() }).catch(
    (e) => ({ ok: false, error: String(e?.message ?? e) }),
  );
  if (!r?.ok) {
    await setShare(null, null, r?.error ?? 'Could not start capture.');
    await closeOffscreen();
    return { ok: false, error: r?.error ?? 'Could not start capture.' };
  }
  return { ok: true };
}

async function stopShare(reason = 'stopped', error = null) {
  if (await hasOffscreen()) await toOffscreen({ cmd: 'stop', reason }).catch(() => {});
  await closeOffscreen(); // closing the document also releases the tab capture
  await setShare(null, null, error);
}

async function toggleForTab(tab) {
  if (!tab?.id) return;
  const share = await getShare();
  if (share?.tabId === tab.id) await stopShare('toggled off');
  else {
    const r = await startShare(tab.id);
    if (!r.ok) await chrome.storage.session.set({ lastError: r.error });
  }
}

// ---------- events ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.to !== 'bg') return false;

  if (msg.event === 'status') {
    // From the offscreen document, ~1/s while sharing.
    getShare().then((share) => {
      if (!share) return;
      chrome.storage.session.set({ live: msg.status });
      updateBadge(share, msg.status);
    });
    return false;
  }
  if (msg.event === 'ended') {
    // The offscreen document stopped by itself (tab capture ended, server error, ...).
    stopShare(msg.reason, msg.reason);
    return false;
  }

  (async () => {
    switch (msg.cmd) {
      case 'share':
        return startShare(msg.tabId);
      case 'stop':
        await stopShare('stopped');
        return { ok: true };
      case 'monitor':
        if (await hasOffscreen()) await toOffscreen({ cmd: 'monitor', monitor: msg.monitor, monitorVolume: msg.monitorVolume });
        return { ok: true };
      default:
        return { ok: false, error: 'unknown command' };
    }
  })().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const share = await getShare();
  if (share?.tabId === tabId) await stopShare('tab closed', 'The shared tab was closed.');
});

chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (!('title' in change || 'audible' in change || 'favIconUrl' in change || 'url' in change)) return;
  const share = await getShare();
  if (share?.tabId !== tabId) return;
  const source = sourceFromTab(tab);
  if (JSON.stringify(source) === JSON.stringify(share.source)) return;
  await chrome.storage.session.set({ share: { ...share, source } });
  if (await hasOffscreen()) toOffscreen({ cmd: 'meta', source }).catch(() => {});
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-share') toggleForTab(tab);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'toggle-share',
    title: 'Share / stop sharing this tab to Discord',
    contexts: ['page', 'audio', 'video'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'toggle-share') toggleForTab(tab);
});

// If the browser restarted or the offscreen document died, clear stale state.
(async () => {
  const share = await getShare();
  if (share && !(await hasOffscreen())) await setShare(null, null, null);
})();
