"use client";

import { useActionState } from "react";
import { setupAction } from "../actions";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input } from "@/components/ui/form";

export function SetupForm() {
  const [state, action, pending] = useActionState(setupAction, undefined);
  return (
    <form action={action} className="mt-6 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Workspace" htmlFor="workspaceName">
          <Input id="workspaceName" name="workspaceName" defaultValue="Orbit Growth" required />
        </Field>
        <Field label="Product you sell" htmlFor="productName">
          <Input id="productName" name="productName" defaultValue="Orbit" required />
        </Field>
      </div>
      <Field label="Your name" htmlFor="name">
        <Input id="name" name="name" autoComplete="name" required />
      </Field>
      <Field label="Email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </Field>
      <Field label="Password" htmlFor="password" hint="10+ chars, letters & a number">
        <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={10} />
      </Field>
      <FormError message={state?.error} />
      <Button type="submit" variant="primary" className="w-full" loading={pending}>
        Create workspace
      </Button>
    </form>
  );
}
