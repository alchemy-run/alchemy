"use client";

// Client side: TYPE-ONLY import + type-only form — zero backend bytes in
// the client bundle. Each call POSTs the wire protocol
// (`/api/__rpc/bump`), which reaches the backend through the catch-all
// route handler at app/api/[[...slug]]/route.ts.
import { createClient } from "alchemy/client";
import { useState } from "react";
import type Backend from "./backend.ts";

const backend = createClient<typeof Backend>();

export default function Visits() {
  const [bumped, setBumped] = useState<number | null>(null);

  return (
    <div className="mt-2">
      <button
        className="rounded border border-slate-300 px-3 py-1 hover:bg-slate-100"
        onClick={async () => setBumped(await backend.bump())}
      >
        Bump visits
      </button>
      {bumped !== null && (
        <p className="mt-2">
          Client bump → <span className="font-semibold">{bumped}</span>
        </p>
      )}
    </div>
  );
}
