import { randomBytes } from "node:crypto";

/** Minimal RFC 5322 message builder (plain text + simple HTML alternative). */

export interface OutgoingEmail {
  fromName: string | null;
  fromEmail: string;
  to: string;
  subject: string;
  text: string;
  replyTo?: string | null;
  inReplyTo?: string | null;     // RFC Message-ID we're replying/following up to
  references?: string | null;
  unsubscribeUrl?: string | null;
  unsubscribeMailto?: string | null;
}

function encodeHeader(v: string): string {
  // RFC 2047 for non-ASCII header values.
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

function address(name: string | null, email: string): string {
  if (!name) return email;
  const safe = name.replace(/["\\\r\n]/g, "");
  return `${encodeHeader(`"${safe}"`)} <${email}>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function textToHtml(text: string): string {
  const linked = escapeHtml(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1c1917">${linked
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px">${p.replace(/\n/g, "<br>")}</p>`)
    .join("")}</div>`;
}

export function newMessageId(domain: string): string {
  return `<${Date.now().toString(36)}.${randomBytes(9).toString("hex")}@${domain || "outbound.local"}>`;
}

export function buildMime(e: OutgoingEmail, messageId: string): string {
  const boundary = `b_${randomBytes(12).toString("hex")}`;
  const headers = [
    `From: ${address(e.fromName, e.fromEmail)}`,
    `To: ${e.to}`,
    `Subject: ${encodeHeader(e.subject.replace(/[\r\n]+/g, " "))}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
  ];
  if (e.replyTo) headers.push(`Reply-To: ${e.replyTo}`);
  if (e.inReplyTo) headers.push(`In-Reply-To: ${e.inReplyTo}`, `References: ${e.references ?? e.inReplyTo}`);
  const unsub = [e.unsubscribeUrl && `<${e.unsubscribeUrl}>`, e.unsubscribeMailto && `<mailto:${e.unsubscribeMailto}?subject=unsubscribe>`].filter(Boolean);
  if (unsub.length) headers.push(`List-Unsubscribe: ${unsub.join(", ")}`);
  if (e.unsubscribeUrl) headers.push("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  return [
    headers.join("\r\n"),
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(e.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(textToHtml(e.text)),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

/** Visible footer: who is sending, postal address (where required), how to opt out. */
export function footer(identity: { senderName: string; company: string; address: string | null }, unsubscribeUrl: string): string {
  return [
    "",
    "—",
    `${identity.senderName}, ${identity.company}${identity.address ? ` · ${identity.address}` : ""}`,
    `Not relevant? Unsubscribe in one click: ${unsubscribeUrl} (or just reply "stop").`,
  ].join("\n");
}
