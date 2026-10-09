"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Upload, FileSpreadsheet, AlertTriangle } from "lucide-react";
import { Panel, Badge } from "@/components/ui/display";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/form";
import { Table, Th, Td, Tr } from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { categoryLabel } from "@/server/domain/taxonomy";
import type { Mapping, PreviewRow } from "@/server/services/importer";
import { previewImportAction, startImportAction } from "./actions";

const FIELDS: { key: keyof Mapping; label: string }[] = [
  { key: "business_name", label: "Business name *" }, { key: "category", label: "Category" }, { key: "city", label: "City" }, { key: "area", label: "Area / address" },
  { key: "instagram", label: "Instagram" }, { key: "tiktok", label: "TikTok" }, { key: "phone", label: "Phone" }, { key: "whatsapp", label: "WhatsApp" },
  { key: "email", label: "Email" }, { key: "website", label: "Website" }, { key: "booking_url", label: "Booking link" }, { key: "bio", label: "Bio" },
  { key: "description", label: "Description" }, { key: "owner_name", label: "Owner name" }, { key: "followers", label: "Followers" }, { key: "state", label: "State" },
  { key: "country", label: "Country" }, { key: "facebook", label: "Facebook" }, { key: "external_id", label: "External ID" },
];

export function ImportWizard({ campaigns }: { campaigns: { id: string; name: string }[] }) {
  const router = useRouter();
  const [csv, setCsv] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [preset, setPreset] = useState("generic");
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Mapping>({});
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [total, setTotal] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [campaign, setCampaign] = useState("");
  const [pending, start] = useTransition();

  const runPreview = (text: string, p: string, m?: Mapping) =>
    start(async () => {
      const r = await previewImportAction(text, p, m);
      if (!r.ok) return toast.error(r.error);
      setHeaders(r.headers);
      setMapping(r.mapping);
      setPreview(r.preview);
      setTotal(r.total);
      setErrors(r.errors);
    });

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 15_000_000) return toast.error("File is too large (max 15 MB)");
    const text = await f.text();
    setCsv(text);
    setFilename(f.name);
    runPreview(text, preset);
  };

  const dupCount = preview.filter((p) => p.duplicateOf).length;

  return (
    <Panel title="Import a CSV" description="Your own lists, Foursquare open data exports, or any spreadsheet. Columns are matched automatically; you confirm before anything is saved.">
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Format">
            <Select value={preset} onChange={(e) => { setPreset(e.target.value); if (csv) runPreview(csv, e.target.value); }} className="w-56">
              <option value="generic">Generic CSV</option>
              <option value="foursquare_os">Foursquare Open Source Places</option>
            </Select>
          </Field>
          <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[13px] font-medium shadow-sm hover:bg-surface-2">
            <Upload className="size-4" /> {filename ? "Choose another file" : "Choose CSV file"}
            <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
          {filename ? <span className="inline-flex items-center gap-1.5 text-[12.5px] text-fg-2"><FileSpreadsheet className="size-4" />{filename} · {total.toLocaleString()} rows</span> : null}
        </div>

        {headers.length ? (
          <>
            <div>
              <h3 className="mb-2 text-[12px] font-medium text-fg-2">Column mapping</h3>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {FIELDS.map((f) => (
                  <Field key={f.key} label={f.label}>
                    <Select value={mapping[f.key] ?? ""} onChange={(e) => setMapping((m) => ({ ...m, [f.key]: e.target.value || undefined }))}>
                      <option value="">—</option>
                      {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                    </Select>
                  </Field>
                ))}
              </div>
              <Button size="sm" className="mt-2" onClick={() => csv && runPreview(csv, preset, mapping)} loading={pending}>Update preview</Button>
            </div>

            {errors.length ? <ul className="space-y-1 text-[12px] text-warning">{errors.map((e) => <li key={e} className="flex gap-1.5"><AlertTriangle className="mt-0.5 size-3" />{e}</li>)}</ul> : null}

            {preview.length ? (
              <div>
                <h3 className="mb-2 text-[12px] font-medium text-fg-2">Preview (first {preview.length} rows) · {dupCount} already in your database or possible duplicates</h3>
                <div className="rounded-md border border-border">
                  <Table>
                    <thead><tr><Th>#</Th><Th>Business</Th><Th>Category</Th><Th>City</Th><Th>Instagram</Th><Th>Phone</Th><Th>Duplicate check</Th></tr></thead>
                    <tbody>
                      {preview.map((r) => (
                        <Tr key={r.index}>
                          <Td className="text-fg-3">{r.index + 2}</Td>
                          <Td className="font-medium">{r.prospect?.business_name ?? <span className="text-danger">{r.issue}</span>}</Td>
                          <Td className="text-fg-2">{r.prospect?.category ? categoryLabel(r.prospect.category) : "—"}</Td>
                          <Td className="text-fg-2">{r.prospect?.city ?? "—"}</Td>
                          <Td className="text-fg-2">{r.prospect?.instagram_handle ? `@${r.prospect.instagram_handle}` : "—"}</Td>
                          <Td className="text-fg-2">{r.prospect?.phone ?? "—"}</Td>
                          <Td>{r.duplicateOf ? <Badge tone={r.duplicateOf.decision === "merge" ? "info" : "warning"}>{r.duplicateOf.decision === "merge" ? "Will update" : "Possible dup"} · {r.duplicateOf.name} ({r.duplicateOf.confidence}%)</Badge> : <Badge tone="success">New</Badge>}</Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              </div>
            ) : null}

            <div className="flex flex-wrap items-end gap-3 border-t border-border pt-4">
              <Field label="Add to campaign">
                <Select value={campaign} onChange={(e) => setCampaign(e.target.value)} className="w-64"><option value="">None</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
              </Field>
              <Button variant="primary" disabled={!mapping.business_name || !csv} loading={pending} onClick={() => start(async () => {
                const r = await startImportAction(csv!, mapping, preset, campaign || null, filename);
                if (r.ok) { toast(r.message ?? "Import started"); setCsv(null); setHeaders([]); setPreview([]); setFilename(null); router.refresh(); } else toast.error(r.error);
              })}>Import {total.toLocaleString()} rows</Button>
              <p className="text-[11.5px] text-fg-3">Exact matches (same handle/phone/email) update existing records. Fuzzy matches are flagged for review, never merged silently.</p>
            </div>
          </>
        ) : null}
      </div>
    </Panel>
  );
}
