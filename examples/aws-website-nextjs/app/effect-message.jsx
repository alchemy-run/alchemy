"use client";

import { useEffect, useState } from "react";

// The effect fetch owns unmatched /api/* routes through the catch-all
// route handler (app/api/[[...slug]]/route.ts) — /api/message is the
// S3-backed handler declared in src/site.ts, served by the same Lambda
// that renders this page.
export default function EffectMessage() {
  const [message, setMessage] = useState("…");
  const [draft, setDraft] = useState("");

  const refresh = async () => {
    const res = await fetch("/api/message");
    const body = await res.json();
    setMessage(body.message ?? "(nothing saved yet)");
  };

  const save = async (event) => {
    event.preventDefault();
    const res = await fetch(`/api/message?put=${encodeURIComponent(draft)}`);
    const body = await res.json();
    setMessage(body.message);
    setDraft("");
  };

  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="mt-4">
      <p>
        Saved message (from <code>/api/message</code>, S3-backed): {message}
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
