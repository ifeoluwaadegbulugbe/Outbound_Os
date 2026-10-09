// Runs on the Outbound OS web app. Announces the extension and relays
// "open this conversation" requests from the Send session to the background.
(() => {
  document.documentElement.dataset.obExtension = "1";
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const d = event.data;
    if (!d || d.type !== "OB_OPEN_CONVERSATION") return;
    chrome.runtime.sendMessage({
      type: "OPEN_CONVERSATION",
      appOrigin: location.origin,
      message: { id: d.messageId, channel: d.channel, url: d.url, text: d.text, handle: d.handle },
    });
  });
})();
