import { resolveTxt, resolveCname } from "node:dns/promises";
import { FREE_PROVIDERS, domainOfEmail } from "./address";

/**
 * Sender-domain authentication checks (SPF, DKIM, DMARC) via public DNS.
 * Free-mail addresses (gmail.com, outlook.com) are authenticated by the
 * provider itself. For your own domain, all three should pass before scaling.
 */

export interface DnsCheck {
  domain: string;
  managedByProvider: boolean;
  spf: { ok: boolean; record: string | null; note: string };
  dkim: { ok: boolean | null; selector: string | null; note: string };
  dmarc: { ok: boolean; record: string | null; policy: string | null; note: string };
  checkedAt: string;
}

async function txt(name: string): Promise<string[]> {
  try {
    return (await resolveTxt(name)).map((r) => r.join(""));
  } catch {
    return [];
  }
}

export async function checkSenderDomain(email: string, provider: string): Promise<DnsCheck> {
  const domain = domainOfEmail(email);
  const checkedAt = new Date().toISOString();
  if (FREE_PROVIDERS.has(domain) || ["googlemail.com", "hotmail.co.uk"].includes(domain)) {
    return {
      domain, managedByProvider: true, checkedAt,
      spf: { ok: true, record: null, note: "Managed by the mail provider" },
      dkim: { ok: true, selector: null, note: "Signed by the mail provider" },
      dmarc: { ok: true, record: null, policy: null, note: "Managed by the mail provider" },
    };
  }
  const spfRec = (await txt(domain)).find((r) => r.toLowerCase().startsWith("v=spf1")) ?? null;
  const expectInclude = provider === "gmail" ? "_spf.google.com" : provider === "microsoft" ? "spf.protection.outlook.com" : null;
  const spfOk = Boolean(spfRec && (!expectInclude || spfRec.includes(expectInclude)));
  const dmarcRec = (await txt(`_dmarc.${domain}`)).find((r) => r.toLowerCase().startsWith("v=dmarc1")) ?? null;
  const policy = dmarcRec ? /p=(none|quarantine|reject)/i.exec(dmarcRec)?.[1]?.toLowerCase() ?? null : null;
  const selectors = provider === "gmail" ? ["google"] : provider === "microsoft" ? ["selector1", "selector2"] : ["google", "selector1", "default"];
  let dkimSel: string | null = null;
  for (const s of selectors) {
    const name = `${s}._domainkey.${domain}`;
    const t = await txt(name);
    let found = t.some((r) => /v=dkim1|k=rsa|p=/i.test(r));
    if (!found) {
      try {
        found = (await resolveCname(name)).length > 0;
      } catch {
        found = false;
      }
    }
    if (found) {
      dkimSel = s;
      break;
    }
  }
  return {
    domain, managedByProvider: false, checkedAt,
    spf: { ok: spfOk, record: spfRec, note: spfRec ? (spfOk ? "SPF authorises your mail provider" : `SPF exists but doesn't include ${expectInclude}`) : "No SPF record — add one before sending" },
    dkim: { ok: dkimSel ? true : null, selector: dkimSel, note: dkimSel ? `DKIM key found (${dkimSel})` : "No DKIM key found at the default selector — enable DKIM in your mail admin console (a custom selector can't be detected automatically)" },
    dmarc: { ok: Boolean(dmarcRec), record: dmarcRec, policy, note: dmarcRec ? `DMARC policy: ${policy ?? "set"}` : "No DMARC record — add v=DMARC1; p=none; rua=… to start monitoring" },
  };
}
