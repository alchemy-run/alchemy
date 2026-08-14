"use client";

import { createClient } from "alchemy/Client";
import { useState } from "react";
import type Backend from "./backend";

// The TYPE-ONLY form: zero backend bytes in the client bundle — methods
// POST to /api/__rpc/<method> on this same Worker. The initial value is
// server-rendered by the value form in app/page.tsx.
const backend = createClient<typeof Backend>();

export default function Visits({ initial }: { initial: number }) {
  const [bumped, setBumped] = useState<number | null>(null);
  return (
    <div className="mt-6 max-w-md rounded-xl border border-slate-300 bg-white p-6 shadow-sm">
      <p className="m-0 text-sm text-gray-500">
        Server-rendered visits: <span data-testid="count">{initial}</span>
      </p>
      <button
        type="button"
        className="mt-4 cursor-pointer rounded-lg bg-slate-900 px-4 py-2 text-white"
        onClick={async () => {
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
  );
}
