"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { login, logout, setupFirstOwner, hasAnyUser, AuthError } from "@/server/auth/service";
import { setSessionCookie, clearSessionCookie, userAgent, SESSION_COOKIE } from "@/server/auth/session";
import { validatePasswordStrength } from "@/server/auth/password";
import { cookies } from "next/headers";

export type FormState = { error?: string } | undefined;

function safeNext(next: FormDataEntryValue | null): string {
  const n = typeof next === "string" ? next : "";
  return n.startsWith("/") && !n.startsWith("//") ? n : "/";
}

export async function loginAction(_: FormState, form: FormData): Promise<FormState> {
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password." };
  try {
    const { token } = await login(email, password, await userAgent());
    await setSessionCookie(token);
  } catch (e) {
    if (e instanceof AuthError) return { error: e.message };
    console.error("[login]", e);
    return { error: "Couldn't sign in. Try again." };
  }
  redirect(safeNext(form.get("next")));
}

const setupSchema = z.object({
  workspaceName: z.string().trim().min(2, "Workspace name is too short").max(80),
  productName: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1, "Your name is required").max(100),
  email: z.string().trim().email("Enter a valid email"),
  password: z.string(),
});

export async function setupAction(_: FormState, form: FormData): Promise<FormState> {
  if (await hasAnyUser()) return { error: "Setup is already complete. Sign in instead." };
  const parsed = setupSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  const weak = validatePasswordStrength(parsed.data.password);
  if (weak) return { error: weak };
  try {
    await setupFirstOwner(parsed.data);
    const { token } = await login(parsed.data.email, parsed.data.password, await userAgent());
    await setSessionCookie(token);
  } catch (e) {
    if (e instanceof AuthError) return { error: e.message };
    console.error("[setup]", e);
    return { error: "Setup failed. Check the server logs." };
  }
  redirect("/?welcome=1");
}

export async function logoutAction(): Promise<void> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) await logout(token);
  await clearSessionCookie();
  redirect("/login");
}
