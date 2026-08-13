"use client";

import { createClient } from "alchemy/client";
import { useState } from "react";
import type Backend from "../src/backend";

// The TYPE-ONLY form: zero backend bytes in the client bundle — methods
// POST to /api/__rpc/<method> on this same Worker. The initial value is
// server-rendered by the value form in app/page.tsx.
const backend = createClient<typeof Backend>();

export default function Visits({ initial }: { initial: number }) {
  const [visits, setVisits] = useState(initial);
  return (
    <div className="mt-6 max-w-md rounded-xl border border-slate-300 bg-white p-6 shadow-sm">
      <p className="m-0 text-sm text-gray-500">
        Visits (rendered on the server via the backend client):
      </p>
      <p className="mt-2 text-4xl font-bold" data-testid="count">
        {visits}
      </p>
      <button
        type="button"
        className="mt-4 cursor-pointer rounded-lg bg-slate-900 px-4 py-2 text-white"
        onClick={async () => {
          setVisits(await backend.visit());
        }}
      >
        Visit again
      </button>
    </div>
  );
}
