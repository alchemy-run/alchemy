"use client";

// The async leg's client side: `enqueue` sends to SQS through the wire
// protocol (`/api/__rpc/enqueue`) and returns immediately — the sibling
// consumer Lambda catches up out of band. After a send, poll
// `processed()` (bounded) until the count moves so the catch-up is
// visible. The SSR-rendered initial value arrives via props from the
// server component (the value form of createClient).
import { createClient } from "alchemy/client";
import { useState } from "react";
import type Backend from "./backend.ts";

const backend = createClient<typeof Backend>();

export default function Queue(props: {
  initial: { count: number; last: string | null };
}) {
  const [text, setText] = useState("");
  const [processed, setProcessed] = useState(props.initial);

  const enqueue = async () => {
    const before = processed.count;
    await backend.enqueue(text || "hello queue");
    for (let i = 0; i < 15; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const next = await backend.processed();
      setProcessed(next);
      if (next.count > before) break;
    }
  };

  return (
    <div className="mt-6 border-t border-slate-200 pt-4">
      <div className="flex gap-2">
        <input
          className="rounded border border-slate-300 px-3 py-1"
          placeholder="hello queue"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <button
          className="rounded border border-slate-300 px-3 py-1 hover:bg-slate-100"
          onClick={enqueue}
        >
          Send to queue
        </button>
      </div>
      <p className="mt-2">
        Queue-processed:{" "}
        <span className="font-semibold">{processed.count}</span> — last:{" "}
        <span className="font-semibold">{processed.last ?? "—"}</span>
      </p>
    </div>
  );
}
