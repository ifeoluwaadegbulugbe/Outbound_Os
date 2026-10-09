import { processUnsubscribe } from "@/server/email/unsubscribe";

/**
 * Public unsubscribe endpoint.
 * GET  → confirmation page with a single button (avoids link-scanner unsubscribes).
 * POST → unsubscribes immediately (RFC 8058 one-click via List-Unsubscribe-Post, or the button).
 */
function page(title: string, body: string) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#fafaf9;color:#1c1917;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
main{max-width:420px;background:#fff;border:1px solid #e7e5e2;border-radius:12px;padding:28px}h1{font-size:18px;margin:0 0 8px}button{margin-top:14px;background:#1c1917;color:#fff;border:0;border-radius:8px;padding:10px 16px;font:600 14px system-ui;cursor:pointer}p{color:#57534e;margin:6px 0}</style>
</head><body><main>${body}</main></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } },
  );
}

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (token === "test") return page("Unsubscribe", "<h1>This is a test email</h1><p>The unsubscribe link in real emails works from here.</p>");
  return page("Unsubscribe", `<h1>Stop these emails?</h1><p>You won't receive further outreach emails from us.</p>
<form method="post"><button type="submit">Unsubscribe</button></form>`);
}

export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = await processUnsubscribe(token);
  if (!r.ok) return page("Unsubscribe", "<h1>Link not recognised</h1><p>Reply “stop” to the email and we'll remove you right away.</p>");
  return page("Unsubscribed", "<h1>You're unsubscribed</h1><p>You won't hear from us again. Sorry for the bother.</p>");
}
