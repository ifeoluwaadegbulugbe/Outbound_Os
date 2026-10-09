import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { sessionFromToken, ROLE_RANK, type Role, type SessionUser, SESSION_TTL_DAYS } from "./service";
import { withWorkspace, type Q } from "../db";

export const SESSION_COOKIE = "ob_session";

export async function setSessionCookie(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_DAYS * 86_400,
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/** Current user, memoized per request. Null when signed out. */
export const getUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return sessionFromToken(token);
});

export class ForbiddenError extends Error {
  constructor(message = "You don't have permission to do that.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * For pages: redirect to /login when signed out.
 * For server actions: same check — server actions are public POST endpoints,
 * so every action must call this (Next.js data-security guidance).
 */
export async function requireUser(minRole: Role = "viewer"): Promise<SessionUser> {
  const user = await getUser();
  if (!user) redirect("/login");
  if (ROLE_RANK[user.role] < ROLE_RANK[minRole]) throw new ForbiddenError();
  return user;
}

export function can(user: Pick<SessionUser, "role">, minRole: Role): boolean {
  return ROLE_RANK[user.role] >= ROLE_RANK[minRole];
}

/** Run a workspace-scoped (RLS) transaction as the given user. */
export function asUser<T>(user: SessionUser, fn: (q: Q) => Promise<T>): Promise<T> {
  return withWorkspace({ workspaceId: user.workspaceId, userId: user.userId }, fn);
}

export async function userAgent(): Promise<string | null> {
  return (await headers()).get("user-agent");
}
