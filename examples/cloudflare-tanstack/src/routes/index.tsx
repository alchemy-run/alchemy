import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { backend } from "../lib/backend.ts";

export const Route = createFileRoute("/")({
  // The isomorphic backend client: during SSR this is the value form
  // (direct in-process dispatch against src/backend.ts — no HTTP); on
  // client-side navigation it is the type-only form (POST /api/__rpc/visits).
  loader: async () => ({
    visits: await backend.visits(),
    processed: await backend.processed(),
  }),
  component: Home,
});

function Home() {
  const { visits, processed: initialProcessed } = Route.useLoaderData();
  const [bumped, setBumped] = useState<number | null>(null);
  const [processed, setProcessed] = useState(initialProcessed);
  const [queueText, setQueueText] = useState("");

  // The async leg: enqueue a message, then poll processed() so the
  // consumer's catch-up is visible (bounded — stop once count grows).
  async function sendToQueue() {
    const before = (await backend.processed()).count;
    await backend.enqueue(queueText || "hello queue");
    for (let i = 0; i < 15; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const p = await backend.processed();
      setProcessed(p);
      if (p.count > before) break;
    }
  }

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-3xl font-bold">TanStack Start on Cloudflare Workers</h1>
      <div className="mt-6 max-w-md rounded-xl border border-slate-300 bg-white p-6 shadow-sm">
        <p className="m-0 text-sm text-gray-500">
          Server-rendered visits: <span data-testid="count">{visits}</span>
        </p>
        <button
          type="button"
          className="mt-4 cursor-pointer rounded-lg bg-slate-900 px-4 py-2 text-white"
          onClick={async () => {
            // Client-side: POST /api/__rpc/bump — typed, no fetch code.
            setBumped(await backend.bump());
          }}
        >
          Bump visits
        </button>
        {bumped !== null && (
          <p className="mt-4 text-sm" data-testid="bumped">
            Client bump → {bumped}
          </p>
        )}
      </div>
      <div className="mt-6 max-w-md rounded-xl border border-slate-300 bg-white p-6 shadow-sm">
        <input
          className="w-full rounded-lg border border-slate-300 px-3 py-2"
          placeholder="hello queue"
          value={queueText}
          onChange={(e) => setQueueText(e.target.value)}
        />
        <button
          type="button"
          className="mt-4 cursor-pointer rounded-lg bg-slate-900 px-4 py-2 text-white"
          onClick={sendToQueue}
        >
          Send to queue
        </button>
        <p className="mt-4 text-sm text-gray-500" data-testid="processed">
          Queue-processed:{" "}
          <span data-testid="processed-count">{processed.count}</span> — last:{" "}
          <span data-testid="processed-last">{processed.last ?? "—"}</span>
        </p>
      </div>
    </main>
  );
}
