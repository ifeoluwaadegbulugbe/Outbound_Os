"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Panel, Badge } from "@/components/ui/display";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea, Checkbox } from "@/components/ui/form";
import { toast } from "@/components/ui/toast";
import type { ActionResult } from "@/components/ui/dialog";
import { timeAgo } from "@/lib/utils";
import {
  saveEmailSettingsAction, saveCountryPolicyAction, addCategoryAction, toggleCategoryAction, addLocationAction, toggleLocationAction,
} from "./email-actions";

function useAct() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<ActionResult>, done?: () => void) => start(async () => {
    const r = await fn();
    if (r.ok) { toast(r.message ?? "Saved"); done?.(); router.refresh(); } else toast.error(r.error);
  });
  return { pending, run };
}

const STATUS_OPTS = [
  { key: "verified", label: "Verified", hint: "Mailbox confirmed (ZeroBounce)" },
  { key: "unknown", label: "Deliverability unknown", hint: "Domain accepts mail; mailbox not confirmed" },
  { key: "catch_all", label: "Catch-all", hint: "Domain accepts everything" },
  { key: "risky", label: "Risky", hint: "Not recommended" },
];

export interface EmailSettingsValue {
  senderName: string; company: string; address: string; defaultCountry: string; allowedStatuses: string[];
  autoVerifyBeforeSend: boolean; requireReviewForNew: boolean; maxBounceRate: number; maxComplaintRate: number; minSample: number;
}

export function EmailSettingsForm({ value, canEdit, countries }: { value: EmailSettingsValue; canEdit: boolean; countries: { code: string; name: string }[] }) {
  const { pending, run } = useAct();
  const [v, setV] = useState(value);
  const set = <K extends keyof EmailSettingsValue>(k: K, x: EmailSettingsValue[K]) => setV({ ...v, [k]: x });
  return (
    <>
      <Panel title="Sender identity" description="Every email ends with your name, business and a postal address plus an unsubscribe link. Anti-spam laws require this, and it builds trust.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Your name"><Input value={v.senderName} disabled={!canEdit} onChange={(e) => set("senderName", e.target.value)} placeholder="Ada Okafor" /></Field>
          <Field label="Business name"><Input value={v.company} disabled={!canEdit} onChange={(e) => set("company", e.target.value)} placeholder="Orbit" /></Field>
          <Field label="Postal address" className="sm:col-span-2" hint="Shown in the footer"><Input value={v.address} disabled={!canEdit} onChange={(e) => set("address", e.target.value)} placeholder="12 Admiralty Way, Lekki, Lagos, Nigeria" /></Field>
          <Field label="Default country" hint="For prospects with no country set">
            <Select value={v.defaultCountry} disabled={!canEdit} onChange={(e) => set("defaultCountry", e.target.value)}>
              {countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
            </Select>
          </Field>
        </div>
      </Panel>
      <Panel title="Sending policy" description="Which addresses can be emailed. Invalid addresses are never sent to.">
        <div className="space-y-3 text-[12.5px]">
          <div>
            <p className="mb-1.5 font-medium">Send to addresses that are…</p>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {STATUS_OPTS.map((s) => (
                <label key={s.key} className="flex items-start gap-2">
                  <Checkbox className="mt-0.5" disabled={!canEdit} checked={v.allowedStatuses.includes(s.key)}
                    onChange={(e) => set("allowedStatuses", e.target.checked ? [...v.allowedStatuses, s.key] : v.allowedStatuses.filter((x) => x !== s.key))} />
                  <span>{s.label} <span className="text-fg-3">· {s.hint}</span></span>
                </label>
              ))}
            </div>
          </div>
          <label className="flex items-start gap-2"><Checkbox className="mt-0.5" disabled={!canEdit} checked={v.autoVerifyBeforeSend} onChange={(e) => set("autoVerifyBeforeSend", e.target.checked)} /> Check addresses that haven&apos;t been verified yet automatically before sending</label>
          <label className="flex items-start gap-2"><Checkbox className="mt-0.5" disabled={!canEdit} checked={v.requireReviewForNew} onChange={(e) => set("requireReviewForNew", e.target.checked)} /> New drafts need human review before they can be queued (recommended)</label>
        </div>
      </Panel>
      <Panel title="Automatic safety pause" description="A sending account pauses itself and alerts you if its recent emails cross these thresholds.">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Max bounce rate (%)"><Input type="number" step="0.5" disabled={!canEdit} value={String(+(v.maxBounceRate * 100).toFixed(2))} onChange={(e) => set("maxBounceRate", Number(e.target.value) / 100)} /></Field>
          <Field label="Max complaint rate (%)"><Input type="number" step="0.05" disabled={!canEdit} value={String(+(v.maxComplaintRate * 100).toFixed(3))} onChange={(e) => set("maxComplaintRate", Number(e.target.value) / 100)} /></Field>
          <Field label="Only after this many sends"><Input type="number" disabled={!canEdit} value={String(v.minSample)} onChange={(e) => set("minSample", Number(e.target.value))} /></Field>
        </div>
        <p className="mt-2 text-[11.5px] text-fg-3">Gmail and Yahoo expect spam complaints below 0.3%. Bounce rates above 5% damage sender reputation.</p>
      </Panel>
      {canEdit ? <div><Button variant="primary" loading={pending} onClick={() => run(() => saveEmailSettingsAction({ ...v, allowedStatuses: v.allowedStatuses as ("verified" | "unknown" | "catch_all" | "risky")[] }))}>Save email settings</Button></div> : null}
    </>
  );
}

export interface PolicyRow { country_code: string; country_name: string; cold_email: string; legal_basis: string | null; notes: string | null; acknowledged_at: string | null; acknowledged_by_name: string | null; prospects: number }

function PolicyEditor({ row, canEdit }: { row: PolicyRow; canEdit: boolean }) {
  const { pending, run } = useAct();
  const [open, setOpen] = useState(false);
  const [cold, setCold] = useState(row.cold_email);
  const [basis, setBasis] = useState(row.legal_basis ?? "");
  const [notes, setNotes] = useState(row.notes ?? "");
  const [ack, setAck] = useState(false);
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <span className="w-40 font-medium">{row.country_name} <span className="text-fg-3">{row.country_code}</span></span>
        <Badge tone={row.cold_email === "allowed" ? "success" : row.cold_email === "blocked" ? "danger" : "warning"}>
          {row.cold_email === "allowed" ? "Cold email allowed" : row.cold_email === "blocked" ? "Blocked" : "Consent required"}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-fg-3">{row.legal_basis ?? "—"}</span>
        <span className="text-fg-3">{row.prospects} prospects</span>
        {canEdit ? <Button size="xs" variant="ghost" onClick={() => setOpen(!open)}>{open ? "Close" : "Edit"}</Button> : null}
      </div>
      {row.acknowledged_at ? <p className="mt-0.5 text-[11.5px] text-fg-3">Reviewed by {row.acknowledged_by_name ?? "an admin"} {timeAgo(row.acknowledged_at)}</p> : null}
      {row.notes && !open ? <p className="mt-0.5 text-[11.5px] text-fg-3">{row.notes}</p> : null}
      {open ? (
        <div className="mt-3 grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2">
          <Field label="Cold email">
            <Select value={cold} onChange={(e) => setCold(e.target.value)}>
              <option value="allowed">Allowed (with legal basis)</option>
              <option value="consent_required">Consent required (no cold email)</option>
              <option value="blocked">Blocked</option>
            </Select>
          </Field>
          <Field label="Legal basis"><Input value={basis} onChange={(e) => setBasis(e.target.value)} placeholder="e.g. NDPA s.25 legitimate interest, LIA on file" /></Field>
          <Field label="Notes" className="sm:col-span-2"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="min-h-14" /></Field>
          {cold === "allowed" ? (
            <label className="flex items-start gap-2 text-[12.5px] sm:col-span-2">
              <Checkbox className="mt-0.5" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              I&apos;ve reviewed this country&apos;s rules on unsolicited business email and documented our legal basis. This isn&apos;t legal advice; get advice if unsure.
            </label>
          ) : null}
          <div className="sm:col-span-2">
            <Button size="sm" variant="primary" loading={pending} onClick={() => run(() => saveCountryPolicyAction({ countryCode: row.country_code, coldEmail: cold as "allowed", legalBasis: basis, notes, acknowledged: cold === "allowed" ? ack : true }), () => setOpen(false))}>Save</Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function CountryPolicies({ rows, canEdit }: { rows: PolicyRow[]; canEdit: boolean }) {
  return (
    <Panel padded={false} title="Country rules" description="Checked before every send. Campaigns can't email prospects in countries where cold email isn't allowed. Defaults: Nigeria allowed under NDPA legitimate interest; South Africa (POPIA s.69), Ghana and Kenya need prior consent.">
      <ul className="divide-y divide-border">{rows.map((r) => <PolicyEditor key={r.country_code} row={r} canEdit={canEdit} />)}</ul>
    </Panel>
  );
}

export function CategoryManager({ rows, canEdit }: { rows: { key: string; label: string; group_name: string; keywords: string[]; osm_tags: string[]; is_active: boolean; prospects: number }[]; canEdit: boolean }) {
  const { pending, run } = useAct();
  const [label, setLabel] = useState("");
  const [keywords, setKeywords] = useState("");
  const [tags, setTags] = useState("");
  return (
    <Panel id="categories" title="Custom categories" description="Add business types without code changes. They appear in discovery, filters, CSV import and scoring. Map tags let OpenStreetMap discovery find them.">
      {rows.length ? (
        <ul className="mb-4 divide-y divide-border rounded-md border border-border">{rows.map((c) => (
          <li key={c.key} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[12.5px]">
            <span className="font-medium">{c.label}</span>
            <span className="text-fg-3">{c.key}</span>
            {c.osm_tags.length ? <Badge tone="info">{c.osm_tags.length} map tag{c.osm_tags.length === 1 ? "" : "s"}</Badge> : <Badge>No map tags</Badge>}
            <span className="ml-auto text-fg-3">{c.prospects} prospects</span>
            {canEdit ? <Button size="xs" variant="ghost" disabled={pending} onClick={() => run(() => toggleCategoryAction(c.key, !c.is_active))}>{c.is_active ? "Disable" : "Enable"}</Button> : null}
          </li>
        ))}</ul>
      ) : null}
      {canEdit ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Car wash" /></Field>
          <Field label="Keywords" hint="comma-separated, used to classify imports"><Input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="car wash, auto detailing" /></Field>
          <Field label="OpenStreetMap tags" hint="one per line" className="sm:col-span-2">
            <Textarea value={tags} onChange={(e) => setTags(e.target.value)} className="min-h-16 font-mono text-[12px]" placeholder={'["amenity"="car_wash"]'} />
          </Field>
          <div><Button size="sm" variant="primary" loading={pending} disabled={!label.trim()} onClick={() => run(() => addCategoryAction({ label, keywords, osmTags: tags }), () => { setLabel(""); setKeywords(""); setTags(""); })}>Add category</Button></div>
        </div>
      ) : null}
    </Panel>
  );
}

export function LocationManager({ rows, canEdit }: { rows: { key: string; city: string; country_code: string; country_name: string; is_active: boolean; is_builtin: boolean; prospects: number }[]; canEdit: boolean }) {
  const { pending, run } = useAct();
  const [f, setF] = useState({ countryCode: "", countryName: "", city: "", south: "", west: "", north: "", east: "" });
  const grouped = rows.reduce<Record<string, typeof rows>>((acc, r) => ((acc[r.country_name] ??= []).push(r), acc), {});
  return (
    <Panel id="locations" title="Locations" description="Cities discovery can search. Built-in cities cover Nigeria first, plus major cities across Africa. Add any city with its bounding box.">
      <div className="space-y-3">
        {Object.entries(grouped).map(([country, list]) => (
          <div key={country}>
            <p className="mb-1 text-[12px] font-medium text-fg-2">{country}</p>
            <div className="flex flex-wrap gap-1.5">{list.map((l) => (
              <button key={l.key} type="button" disabled={!canEdit || pending} onClick={() => run(() => toggleLocationAction(l.key, !l.is_active))}
                title={canEdit ? (l.is_active ? "Click to disable" : "Click to enable") : undefined}
                className={`h-7 rounded-md border px-2.5 text-[12.5px] ${l.is_active ? "border-border bg-surface" : "border-dashed border-border text-fg-3 line-through"}`}>
                {l.city}{l.prospects ? <span className="text-fg-3"> · {l.prospects}</span> : null}
              </button>
            ))}</div>
          </div>
        ))}
      </div>
      {canEdit ? (
        <div className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-4">
          <Field label="Country code"><Input value={f.countryCode} maxLength={2} onChange={(e) => setF({ ...f, countryCode: e.target.value.toUpperCase() })} placeholder="NG" /></Field>
          <Field label="Country name"><Input value={f.countryName} onChange={(e) => setF({ ...f, countryName: e.target.value })} placeholder="Nigeria" /></Field>
          <Field label="City" className="sm:col-span-2"><Input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} placeholder="Abeokuta" /></Field>
          {(["south", "west", "north", "east"] as const).map((k) => (
            <Field key={k} label={k[0].toUpperCase() + k.slice(1)}><Input type="number" step="0.01" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>
          ))}
          <p className="text-[11.5px] text-fg-3 sm:col-span-3">Find the box on openstreetmap.org → Export → “Manually select a different area”. Keep it to one metro area.</p>
          <div><Button size="sm" variant="primary" loading={pending} disabled={!f.countryCode || !f.city}
            onClick={() => run(() => addLocationAction({ countryCode: f.countryCode, countryName: f.countryName, city: f.city, south: Number(f.south), west: Number(f.west), north: Number(f.north), east: Number(f.east) }),
              () => setF({ countryCode: f.countryCode, countryName: f.countryName, city: "", south: "", west: "", north: "", east: "" }))}>Add city</Button></div>
        </div>
      ) : null}
    </Panel>
  );
}
