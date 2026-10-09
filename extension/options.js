const appUrl = document.getElementById("appUrl");
const token = document.getElementById("token");
const out = document.getElementById("out");

chrome.storage.local.get(["appUrl", "token"]).then((s) => {
  appUrl.value = s.appUrl || "http://localhost:3100";
  token.value = s.token || "";
});

document.getElementById("save").onclick = async () => {
  const url = appUrl.value.trim().replace(/\/$/, "");
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    out.textContent = "Enter a valid URL.";
    return;
  }
  // Non-localhost app URLs need permission to call the API and to run the
  // small bridge script on the app pages.
  if (!/^http:\/\/(localhost|127\.0\.0\.1)/.test(origin)) {
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) {
      out.textContent = "Permission is needed to talk to your app.";
      return;
    }
    try {
      await chrome.scripting.unregisterContentScripts({ ids: ["app-bridge-custom"] });
    } catch {
      /* not registered yet */
    }
    await chrome.scripting.registerContentScripts([{ id: "app-bridge-custom", matches: [`${origin}/*`], js: ["app-bridge.js"], runAt: "document_start" }]);
  }
  await chrome.storage.local.set({ appUrl: url, token: token.value.trim() });
  chrome.runtime.sendMessage({ type: "SESSION" }, (r) => {
    out.textContent = r?.error ? `✗ ${r.error}` : `✓ Connected as ${r.user.name} · ${r.queue} approved messages waiting`;
  });
};
