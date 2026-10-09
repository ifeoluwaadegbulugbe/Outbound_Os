import { redirect } from "next/navigation";
import { hasAnyUser } from "@/server/auth/service";
import { getUser } from "@/server/auth/session";
import { LoginForm } from "./login-form";

// Depends on database state (first-run setup) — always render per request.
export const dynamic = "force-dynamic";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (!(await hasAnyUser())) redirect("/setup");
  if (await getUser()) redirect("/");
  const { next } = await searchParams;
  return (
    <>
      <h1 className="text-[20px] font-semibold tracking-tight">Sign in</h1>
      <p className="mt-1 text-[13px] text-fg-3">Your outbound engine is waiting.</p>
      <LoginForm next={next ?? "/"} />
    </>
  );
}
