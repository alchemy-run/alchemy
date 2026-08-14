// SSR seam: VALUE import + `createClient(Backend)` — the backend method
// dispatches directly in-process (no HTTP hop) inside the async server
// component, in the deployed Lambda and under `next dev` alike.
import { createClient } from "alchemy/Client";
import Backend from "./backend.ts";
import Queue from "./queue.tsx";
import Visits from "./visits.tsx";

// Server-rendered in the Lambda on every request — a prerendered page
// must not call the backend server-side.
export const dynamic = "force-dynamic";

const backend = createClient(Backend);

export default async function Home() {
  const visits = await backend.visits();
  const processed = await backend.processed();
  return (
    <main className="mx-auto max-w-2xl p-8">
      <div className="rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-3xl font-bold">Next.js on AWS</h1>
        <p className="mt-4">
          Server-rendered visits:{" "}
          <span id="visits" className="font-semibold">
            {visits}
          </span>
        </p>
        <Visits />
        <Queue initial={processed} />
      </div>
    </main>
  );
}
