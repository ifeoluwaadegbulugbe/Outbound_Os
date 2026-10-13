"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { AtSign, Puzzle, Webhook, Copy, KeyRound } from "lucide-react";
import { Panel, Badge } from "@/components/ui/display";
import { Button } from "@/components/ui/button";
import { ActionButton } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/form";
import { toast } from "@/components/ui/toast";
import { connectInstagramAction, disconnectAction, createExtensionTokenAction, rotateWebhookSecretAction } from "./actions";

function Secret({ value, label }: { value: string; label: string }) {
  return (
    <div className="mt-2 rounded-md border border-warning/30 bg-warning-subtle p-2.5">
      <p className="text-[11.5px] font-medium text-warning">{label} — copy it now, it won&apos;t be shown again</p>
      <div className="mt-1 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1 font-mono text-[12px]">{value}</code>
        <Button size="xs" onClick={async () => { await navigator.clipboard.writeText(value); toast("Copied"); }}><Copy /> Copy</Button>
      </div>
    </div>
  );
}

export function InstagramConnect({ connected, username, canEdit }: { connected: boolean; username: string | null; canEdit: boolean }) {
  const router = useRouter();
  const [igUserId, setIgUserId] = useState("");
  const [token, setToken] = useState("");
  const [cph, setCph] = useState("180");
  const [pending, start] = useTransition();
  return (
    <Panel title={<span className="inline-flex items-center gap-1.5"><AtSign className="size-3.5" /> Connect Instagram (free, official API)</span>}
      actions={connected ? <Badge tone="success">@{username}</Badge> : <Badge tone="warning">Not connected</Badge>}>
      <ol className="list-decimal space-y-1.5 pl-4 text-[12.5px] text-fg-2">
        <li>Make Orbit&apos;s Instagram a <b>Business</b> or <b>Creator</b> account and link it to a Facebook Page (Instagram app → Settings → Account type).</li>
        <li>At <span className="font-mono text-[12px]">developers.facebook.com</span>, create a free app (type “Business”) and add the <b>Instagram</b> product (API setup with Facebook login).</li>
        <li>In Graph API Explorer, generate a token with <span className="font-mono text-[11.5px]">instagram_basic, instagram_manage_insights, pages_show_list, pages_read_engagement, business_management</span> (plus <span className="font-mono text-[11.5px]">ads_read</span> if your Page is in a Business portfolio). Exchange it for a long-lived (60-day) token.</li>
        <li>Find your Instagram account ID: <span className="font-mono text-[11.5px]">GET /me/accounts?fields=instagram_business_account</span>.</li>
        <li>Paste both below. As the app&apos;s only user it usually works in development mode; hashtag search may require Meta App Review — see docs/integrations.md.</li>
      </ol>
      <p className="mt-2 text-[11.5px] text-fg-3">We never ask for your Instagram password. The token is encrypted at rest and only used for discovery lookups — never to send messages.</p>
      {canEdit ? (
        connected ? (
          <div className="mt-3"><ActionButton size="sm" variant="ghost" action={() => disconnectAction("instagram_graph")} onDone={() => router.refresh()}
            confirm={{ title: "Disconnect Instagram?", description: "Discovery from Instagram stops. Existing prospects are kept.", danger: true }}>Disconnect</ActionButton></div>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Instagram account ID"><Input value={igUserId} onChange={(e) => setIgUserId(e.target.value)} placeholder="17841400000000000" inputMode="numeric" /></Field>
            <Field label="Calls per hour" hint="Meta allows ~200/hr per user"><Input type="number" value={cph} onChange={(e) => setCph(e.target.value)} /></Field>
            <Field label="Access token" className="sm:col-span-2"><Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="EAAG…" autoComplete="off" /></Field>
            <div className="sm:col-span-2"><Button variant="primary" loading={pending} disabled={!igUserId || !token} onClick={() => start(async () => {
              const r = await connectInstagramAction({ igUserId, token, callsPerHour: Number(cph) });
              if (r.ok) { toast(r.message ?? "Connected"); setToken(""); router.refresh(); } else toast.error(r.error);
            })}>Verify & connect</Button></div>
          </div>
        )
      ) : <p className="mt-3 text-[12px] text-fg-3">Ask an admin to connect Instagram.</p>}
    </Panel>
  );
}

export function ExtensionSetup({ hasToken, appUrl }: { hasToken: boolean; appUrl: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Panel title={<span className="inline-flex items-center gap-1.5"><Puzzle className="size-3.5" /> Browser extension</span>} actions={hasToken ? <Badge tone="success">Token created</Badge> : null}>
      <ol className="list-decimal space-y-1 pl-4 text-[12.5px] text-fg-2">
        <li>Open <span className="font-mono text-[12px]">chrome://extensions</span> (or Edge), turn on <b>Developer mode</b>.</li>
        <li>Click <b>Load unpacked</b> and choose the <span className="font-mono text-[12px]">outbound_system/extension</span> folder.</li>
        <li>Open the extension&apos;s options, paste the app URL (<span className="font-mono text-[12px]">{appUrl}</span>) and a token from below.</li>
        <li>In Outreach → Send, press Enter: the DM opens with your message typed. You press Send.</li>
      </ol>
      <Button size="sm" className="mt-3" loading={pending} onClick={() => start(async () => { const r = await createExtensionTokenAction(); if (r.ok) setToken(r.token); else toast.error(r.error); })}>
        <KeyRound /> {hasToken ? "Create a new token" : "Create token"}
      </Button>
      {token ? <Secret value={token} label="Extension token" /> : null}
    </Panel>
  );
}

export function WebhookSetup({ endpoint, hasSecret, canEdit }: { endpoint: string; hasSecret: boolean; canEdit: boolean }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const example = `POST ${endpoint}
X-Outbound-Signature: sha256=<hex HMAC-SHA256 of the raw body using your secret>
Content-Type: application/json

{ "type": "signup", "external_user_id": "orbit-user-123", "email": "owner@example.com",
  "phone": "+2348031234567", "ref_code": "<ob_ref from the signup URL>", "occurred_at": "2026-10-08T10:00:00Z" }`;
  return (
    <Panel title={<span className="inline-flex items-center gap-1.5"><Webhook className="size-3.5" /> Orbit conversion webhook</span>} actions={hasSecret ? <Badge tone="success">Secret set</Badge> : <Badge tone="warning">No secret</Badge>}>
      <p className="text-[12.5px] text-fg-2">Orbit sends <b>signup</b>, <b>activated</b> and <b>paid</b> events here. Matching: tracked-link ref → email → phone → Instagram handle. See docs/integrations.md for the 15-line Orbit change.</p>
      <pre className="mt-2 overflow-x-auto rounded-md bg-surface-2 p-2.5 font-mono text-[11px] leading-relaxed text-fg-2">{example}</pre>
      {canEdit ? <Button size="sm" className="mt-3" loading={pending} onClick={() => start(async () => { const r = await rotateWebhookSecretAction(); if (r.ok) setSecret(r.secret); else toast.error(r.error); })}><KeyRound /> {hasSecret ? "Rotate secret" : "Generate secret"}</Button> : null}
      {secret ? <Secret value={secret} label="Webhook signing secret" /> : null}
    </Panel>
  );
}
