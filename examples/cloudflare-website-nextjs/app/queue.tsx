"use client";

import { createClient } from "alchemy/Client";
import { useState } from "react";
import type Backend from "./backend";

// The TYPE-ONLY form: zero backend bytes in the client bundle — methods
// POST to /api/__rpc/<method> on this same Worker. The initial value is
// server-rendered by the value form in app/page.tsx.
const backend = createClient<typeof Backend>();

export default function Queue({
  initial,
}: {
  initial: { count: number; last: string | null };
}) {
  const [processed, setProcessed] = useState(initial);
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
  );
}
