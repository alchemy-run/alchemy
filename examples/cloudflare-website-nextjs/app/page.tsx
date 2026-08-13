import { createClient } from "alchemy/client";
import Backend from "./backend";
import Visits from "./visits";

// Server-rendered in the Worker on every request — the value form must
// never run during prerender (there is no backend at build time).
export const dynamic = "force-dynamic";

export default async function Home() {
  // The SSR seam: a VALUE import of the backend + `createClient(Backend)`
  // dispatches the method in-process inside the Worker — no HTTP hop.
  // Server components never ship to the browser, so the value import is
  // safe here; client components use the type-only form (see visits.tsx).
  const backend = createClient(Backend);
  const visits = await backend.visit();

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-3xl font-bold">Next.js on Cloudflare Workers</h1>
      <p className="mt-2 text-sm text-gray-500">
        Rendered at {new Date().toISOString()}
      </p>
      <Visits initial={visits} />
    </main>
  );
}
