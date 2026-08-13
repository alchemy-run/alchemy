"use client";

// Client side: TYPE-ONLY import + type-only form — zero backend bytes in
// the client bundle. Each call POSTs the wire protocol
// (`/api/__rpc/save`), which reaches the backend through the catch-all
// route handler at app/api/[[...slug]]/route.ts.
import { createClient } from "alchemy/client";
import { useState, type FormEvent } from "react";
import type Backend from "../src/backend.ts";

const backend = createClient<typeof Backend>();

export default function MessageForm({ initial }: { initial: string | null }) {
  const [message, setMessage] = useState(initial ?? "(nothing saved yet)");
  const [draft, setDraft] = useState("");

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setMessage(await backend.save(draft));
    setDraft("");
  };

  return (
    <div className="mt-4">
      <p>
        Live value (updated over the wire by <code>backend.save</code>):{" "}
        <span className="font-semibold">{message}</span>
      </p>
      <form className="mt-2 flex gap-2" onSubmit={save}>
        <input
          className="rounded border px-2 py-1"
          placeholder="say something"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button className="rounded border px-3 py-1" type="submit">
          Save
        </button>
      </form>
    </div>
  );
}
