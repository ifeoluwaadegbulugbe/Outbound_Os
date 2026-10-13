// Runs on instagram.com and tiktok.com. When there's a pending approved
// message, it waits for the DM text box, types the message into it, and shows
// a small bar. It NEVER clicks Send — the human does. After sending, the
// human clicks "Mark sent & next".
(() => {
  if (window.__obComposer) return;
  window.__obComposer = true;

  const COMPOSER_SELECTORS = [
    'div[role="textbox"][contenteditable="true"]',
    'textarea[placeholder*="essage"]',
    'div[contenteditable="true"][data-e2e*="message"]',
    'div[contenteditable="true"]',
  ];

  let filledFor = null;
  let bar = null;

  function findComposer() {
    for (const sel of COMPOSER_SELECTORS) {
      const el = [...document.querySelectorAll(sel)].find((n) => n.offsetParent !== null && n.getBoundingClientRect().width > 120);
      if (el) return el;
    }
    return null;
  }

  const squash = (s) => s.replace(/\s+/g, " ").trim();
  // Line breaks survive if the editor shows each paragraph (it may render blank lines as empty blocks).
  const kept = (el, text) => {
    const shown = el.innerText.replace(/ /g, " ");
    const lines = text.split("\n").filter((l) => l.trim());
    return squash(shown) === squash(text) && shown.split("\n").filter((l) => l.trim()).length >= lines.length;
  };

  async function fill(el, text) {
    el.focus();
    if (el.tagName === "TEXTAREA") {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    // Rich editors (Instagram's) drop "\n" from insertText but keep paragraphs from a paste,
    // so hand the text over as a paste through the editor's own paste handling.
    document.execCommand("selectAll", false);
    const data = new DataTransfer();
    data.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 150));
    if (kept(el, text)) return;
    // Fallback: type line by line with a line break between lines (like Shift+Enter, never Enter/Send).
    el.focus();
    document.execCommand("selectAll", false);
    document.execCommand("delete", false);
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (line) document.execCommand("insertText", false, line);
      if (i < lines.length - 1) document.execCommand("insertLineBreak", false);
    });
  }

  function showBar(state, pending) {
    if (!bar) {
      bar = document.createElement("div");
      bar.style.cssText = "position:fixed;z-index:2147483647;bottom:20px;left:50%;transform:translateX(-50%);background:#1c1917;color:#fff;font:13px system-ui,sans-serif;padding:10px 12px;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.35);display:flex;gap:10px;align-items:center;max-width:92vw";
      document.documentElement.appendChild(bar);
    }
    const name = pending ? pending.handle ? "@" + pending.handle : "this prospect" : "";
    const msg = state === "filled" ? `Message for ${name} is typed in. Review it, press <b>Send</b>, then:`
      : state === "waiting" ? `Open the chat with ${name} (click <b>Message</b>) — the draft fills in automatically.`
      : state;
    bar.innerHTML = `<span style="opacity:.9">${msg}</span>`;
    if (state === "filled" || state === "waiting") {
      const sent = button("Mark sent & next", "#e2496f", () => send("MARK_SENT_AND_NEXT"));
      const skip = button("Skip", "transparent", () => send("SKIP_AND_NEXT"));
      bar.append(sent, skip);
    }
  }

  function button(label, bg, onClick) {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = `background:${bg};color:#fff;border:1px solid rgba(255,255,255,.25);border-radius:7px;padding:5px 10px;font:600 12.5px system-ui;cursor:pointer`;
    b.onclick = onClick;
    return b;
  }

  function send(type) {
    chrome.runtime.sendMessage({ type }, (r) => {
      if (chrome.runtime.lastError) return showBar("Extension error — reload the page.");
      if (r?.error) return showBar(`⚠ ${r.error}`);
      filledFor = null;
      if (r?.done) showBar("✓ Queue empty — nice work. Close this tab or approve more drafts.");
      else if (r?.paused) showBar("Outreach is paused in Outbound OS.");
      else if (r?.demo) showBar("Next item is demo data — open it from the app instead.");
    });
  }

  async function tick() {
    chrome.runtime.sendMessage({ type: "GET_PENDING" }, (r) => {
      if (chrome.runtime.lastError) return;
      const pending = r?.pending;
      if (!pending) {
        if (bar && !filledFor) { bar.remove(); bar = null; }
        return;
      }
      if (filledFor === pending.id) return;
      const el = findComposer();
      if (el && (location.pathname.startsWith("/direct") || location.pathname.startsWith("/messages"))) {
        filledFor = pending.id;
        fill(el, pending.text).then(() => showBar("filled", pending));
      } else {
        showBar("waiting", pending);
      }
    });
  }

  setInterval(tick, 1200);
  tick();
})();
