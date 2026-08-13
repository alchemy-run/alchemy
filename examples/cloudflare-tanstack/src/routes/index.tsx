import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { backend } from "../lib/backend.ts";

export const Route = createFileRoute("/")({
  // The isomorphic backend client: during SSR this is the value form
  // (direct in-process dispatch against src/backend.ts — no HTTP); on
  // client-side navigation it is the type-only form (POST /api/__rpc/visits).
  loader: () => backend.visits(),
  component: Home,
});

function Home() {
  const visits = Route.useLoaderData();
  const [bumped, setBumped] = useState<number | null>(null);

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
    </main>
  );
}
