// Outbound OS Assistant — background service worker.
// Holds the one "pending" message being sent, opens the DM tab, and talks to
// the app API (mark sent / skip / next). It never sends messages itself.

const PENDING_TTL_MS = 15 * 60 * 1000;

async function settings() {
  const s = await chrome.storage.local.get(["appUrl", "token", "workTabId"]);
  return { appUrl: (s.appUrl || "http://localhost:3100").replace(/\/$/, ""), token: s.token || "", workTabId: s.workTabId || null };
}

async function api(path, init = {}) {
  const { appUrl, token } = await settings();
  if (!token) throw new Error("Add your extension token in the extension options.");
  const res = await fetch(`${appUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

async function setPending(message) {
  await chrome.storage.local.set({ pending: { ...message, at: Date.now() } });
}

async function getPending() {
  const { pending } = await chrome.storage.local.get("pending");
  if (!pending || Date.now() - pending.at > PENDING_TTL_MS) return null;
  return pending;
}

async function openInWorkTab(url) {
  const { workTabId } = await settings();
  if (workTabId) {
    try {
      await chrome.tabs.update(workTabId, { url, active: true });
      return;
    } catch {
      /* tab was closed */
    }
  }
  const tab = await chrome.tabs.create({ url, active: true });
  await chrome.storage.local.set({ workTabId: tab.id });
}

async function openMessage(message) {
  if (!message) return { done: true };
  if (!message.url) return { demo: true, message };
  await setPending(message);
  if (message.channel === "whatsapp") {
    // wa.me pre-fills the text natively — no typing needed.
    await chrome.tabs.create({ url: message.url, active: true });
  } else {
    await openInWorkTab(message.url);
  }
  return { opened: true, message };
}

async function next(channel) {
  const r = await api(`/api/ext/next${channel ? `?channel=${channel}` : ""}`);
  if (r.paused) return { paused: true };
  return openMessage(r.message);
}

/**
 * The bridge script on a deployed app URL is registered at runtime (options
 * page), and Chrome drops runtime-registered scripts when the extension is
 * reloaded or updated. Re-register it whenever the worker starts, and inject
 * it into app tabs that are already open, so "Send" keeps reaching us.
 */
async function ensureBridge() {
  const { appUrl } = await settings();
  let origin;
  try {
    origin = new URL(appUrl).origin;
  } catch {
    return;
  }
  if (/^http:\/\/(localhost|127\.0\.0\.1)/.test(origin)) return; // covered by the manifest
  const pattern = `${origin}/*`;
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) return;
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ["app-bridge-custom"] });
  if (!existing.length) {
    await chrome.scripting.registerContentScripts([{ id: "app-bridge-custom", matches: [pattern], js: ["app-bridge.js"], runAt: "document_start" }]);
  } else if (existing[0].matches?.[0] !== pattern) {
    await chrome.scripting.updateContentScripts([{ id: "app-bridge-custom", matches: [pattern] }]);
  }
  for (const tab of await chrome.tabs.query({ url: pattern })) {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["app-bridge.js"] }).catch(() => {});
  }
}

chrome.runtime.onInstalled.addListener(() => ensureBridge().catch(() => {}));
chrome.runtime.onStartup.addListener(() => ensureBridge().catch(() => {}));
ensureBridge().catch(() => {});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "OPEN_CONVERSATION":
          return sendResponse(await openMessage(msg.message));
        case "GET_PENDING":
          return sendResponse({ pending: await getPending() });
        case "MARK_SENT_AND_NEXT": {
          const p = await getPending();
          if (!p) return sendResponse({ error: "Nothing pending" });
          await api("/api/ext/sent", { method: "POST", body: JSON.stringify({ id: p.id }) });
          await chrome.storage.local.remove("pending");
          return sendResponse(await next(p.channel === "whatsapp" ? null : p.channel));
        }
        case "SKIP_AND_NEXT": {
          const p = await getPending();
          if (p) await api("/api/ext/skip", { method: "POST", body: JSON.stringify({ id: p.id }) });
          await chrome.storage.local.remove("pending");
          return sendResponse(await next(p ? p.channel : null));
        }
        case "START":
          return sendResponse(await next(msg.channel || null));
        case "SESSION":
          return sendResponse(await api("/api/ext/session"));
        default:
          return sendResponse({ error: "Unknown request" });
      }
    } catch (e) {
      sendResponse({ error: e instanceof Error ? e.message : String(e) });
    }
  })();
  return true; // async response
});
