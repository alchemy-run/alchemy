import { createFileRoute } from "@tanstack/react-router";
import { QueueCard } from "../components/queue-card.tsx";
import { VisitsCard } from "../components/visits-card.tsx";
import { getProcessed, getVisits } from "../server/visits.ts";

export const Route = createFileRoute("/")({
  // The loader drives the same server functions the browser uses: during
  // SSR they dispatch in-process (the value-form client under the hood);
  // on client-side navigation they go over Start's own transport.
  loader: async () => ({
    visits: await getVisits(),
    processed: await getProcessed(),
  }),
  component: Home,
});

function Home() {
  const { visits, processed } = Route.useLoaderData();

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-3xl font-bold">
        TanStack Start on Cloudflare Workers
      </h1>
      <VisitsCard initial={visits} />
      <QueueCard initial={processed} />
    </main>
  );
}
