"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Textarea } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { addNoteAction } from "./actions";

export function NoteForm({ prospectId }: { prospectId: string }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [pending, start] = useTransition();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await addNoteAction(prospectId, body);
          if (r.ok) {
            setBody("");
            router.refresh();
          } else toast.error(r.error);
        });
      }}
    >
      <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a note…" className="min-h-16" aria-label="Note" />
      <div className="mt-1.5 flex justify-end"><Button type="submit" size="xs" disabled={!body.trim()} loading={pending}>Add note</Button></div>
    </form>
  );
}
