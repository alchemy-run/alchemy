import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { backend } from "../lib/backend.ts";

export const Route = createFileRoute("/")({
  // The isomorphic backend client: during SSR this is the value form
  // (direct in-process dispatch against src/backend.ts — no HTTP); on
  // client-side navigation it is the type-only form (POST /api/__rpc/get).
  loader: () => backend.get(),
  component: Home,
});

function Home() {
  const initial = Route.useLoaderData();
  const [message, setMessage] = useState(initial);
  const [draft, setDraft] = useState("");

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="m-0 text-3xl font-bold">TanStack Start</h1>
      <p className="mt-4 leading-relaxed">
        One Worker serves this app and its typed backend —{" "}
        <code>createClient</code> bridges both worlds.
      </p>
      <div className="mt-6 rounded-xl border border-slate-300 bg-white p-6 shadow-sm">
        <p className="m-0 text-sm text-slate-500">
          Message in R2 (loaded by the SSR loader via the backend client):
        </p>
        <p className="mt-2 rounded-lg bg-slate-200 px-4 py-3 font-mono" data-testid="message">
          {message ?? "No message saved yet."}
        </p>
        <div className="mt-4 flex gap-2">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Write a message…"
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2"
          />
          <button
            type="button"
            onClick={async () => {
              // Client-side: POST /api/__rpc/save — typed, no fetch code.
              setMessage(await backend.save(draft));
              setDraft("");
            }}
            className="cursor-pointer rounded-lg border-none bg-slate-900 px-4 py-2 text-white"
          >
            Save to R2
          </button>
        </div>
      </div>
    </main>
  );
}
