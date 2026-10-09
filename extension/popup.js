const status = document.getElementById("status");
const usage = document.getElementById("usage");

chrome.runtime.sendMessage({ type: "SESSION" }, (r) => {
  if (!r || r.error) {
    status.innerHTML = `<span class="err">${r?.error || "Not connected"}</span> — <a href="options.html" target="_blank">open options</a>`;
    return;
  }
  status.textContent = r.paused ? "Outreach is paused in the app." : `${r.user.name} · ${r.queue} approved message${r.queue === 1 ? "" : "s"} waiting`;
  usage.innerHTML = (r.usage || []).map((u) => `${u.channel}: ${u.sentToday}/${u.cap} today`).join("<br>");
});

for (const [id, channel] of [["start-ig", "instagram"], ["start-tt", "tiktok"], ["start-wa", "whatsapp"]]) {
  document.getElementById(id).onclick = () =>
    chrome.runtime.sendMessage({ type: "START", channel }, (r) => {
      if (r?.error) status.innerHTML = `<span class="err">${r.error}</span>`;
      else if (r?.done) status.textContent = `No approved ${channel} messages. Approve drafts in the app first.`;
      else if (r?.paused) status.textContent = "Outreach is paused in the app.";
      else if (r?.demo) status.textContent = "Next message is for a demo prospect — nothing to open.";
      else window.close();
    });
}
