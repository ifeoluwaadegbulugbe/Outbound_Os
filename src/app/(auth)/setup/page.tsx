import { redirect } from "next/navigation";
import { hasAnyUser } from "@/server/auth/service";
import { SetupForm } from "./setup-form";

// Depends on database state (first-run setup) — always render per request.
export const dynamic = "force-dynamic";

export const metadata = { title: "Set up" };

export default async function SetupPage() {
  if (await hasAnyUser()) redirect("/login");
  return (
    <>
      <h1 className="text-[20px] font-semibold tracking-tight">Set up your workspace</h1>
      <p className="mt-1 text-[13px] text-fg-3">You&apos;ll be the owner. You can invite teammates later.</p>
      <SetupForm />
    </>
  );
}
