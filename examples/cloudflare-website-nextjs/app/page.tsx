import { createClient } from "alchemy/Client";
import Backend from "./backend";
import QueueCard from "./queue-card";
import VisitsCard from "./visits-card";

// Server-rendered in the Worker on every request — the value form must
// never run during prerender (there is no backend at build time).
export const dynamic = "force-dynamic";

export default async function Home() {
  // The SSR seam: a VALUE import of the backend + `createClient(Backend)`
  // dispatches the methods in-process inside the Worker — no HTTP hop.
  // Server components never ship to the browser; the client cards reach
  // the same methods only through the server actions in app/actions.ts.
  const backend = createClient(Backend);
  const visits = await backend.visits();
  const processed = await backend.processed();

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-3xl font-bold">Next.js on Cloudflare Workers</h1>
      <VisitsCard initial={visits} />
      <QueueCard initial={processed} />
    </main>
  );
}
