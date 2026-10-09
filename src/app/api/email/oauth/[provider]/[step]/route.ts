import { NextResponse } from "next/server";
import { getUser, can } from "@/server/auth/session";
import { withWorkspace } from "@/server/db";
import { buildAuthUrl, exchangeCode, providerConfigured, readState, saveConnectedAccount, type MailProvider } from "@/server/email/oauth";
import { audit } from "@/server/services/audit";
import { appUrl } from "@/server/services/links";

/**
 * /api/email/oauth/{gmail|microsoft}/start     → redirect to the provider's consent screen
 * /api/email/oauth/{gmail|microsoft}/callback  → store the encrypted refresh token, back to Data Sources
 */
export async function GET(req: Request, { params }: { params: Promise<{ provider: string; step: string }> }) {
  const { provider, step } = await params;
  if (provider !== "gmail" && provider !== "microsoft") return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  const p = provider as MailProvider;
  const back = (q: string) => NextResponse.redirect(`${appUrl()}/integrations?${q}#sending`);

  if (step === "start") {
    const user = await getUser();
    if (!user) return NextResponse.redirect(`${appUrl()}/login`);
    if (!can(user, "admin")) return back("error=Only+admins+can+connect+sending+accounts");
    if (!providerConfigured(p)) return back(`error=${encodeURIComponent(`${p === "gmail" ? "GOOGLE" : "MS"}_CLIENT_ID and _SECRET are not set — see docs/email.md`)}`);
    return NextResponse.redirect(buildAuthUrl(p, { workspaceId: user.workspaceId, userId: user.userId }));
  }

  if (step === "callback") {
    const url = new URL(req.url);
    const err = url.searchParams.get("error");
    if (err) return back(`error=${encodeURIComponent(url.searchParams.get("error_description") ?? err)}`);
    const state = readState(url.searchParams.get("state") ?? "");
    const code = url.searchParams.get("code");
    if (!state || state.p !== p || !code) return back("error=Connection+expired+—+please+try+again");
    try {
      const r = await exchangeCode(p, code);
      await withWorkspace({ workspaceId: state.workspaceId, userId: state.userId }, async (q) => {
        const id = await saveConnectedAccount(q, state.workspaceId, state.userId, p, r);
        await audit(q, { workspaceId: state.workspaceId, actorType: "user", actorId: state.userId }, "email.account_connected", "sender_account", id, { provider: p, email: r.email });
      });
      return back(`connected=${encodeURIComponent(r.email)}`);
    } catch (e) {
      return back(`error=${encodeURIComponent(e instanceof Error ? e.message : "Connection failed")}`);
    }
  }
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
