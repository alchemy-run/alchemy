import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";

export const getServerTime = createServerFn({
  method: "GET",
}).handler(() => ({
  message: "Hello from a TanStack Start server function.",
  time: new Date().toISOString(),
}));

export const Route = createFileRoute("/")({
  loader: () => getServerTime(),
  component: Home,
});

function Home() {
  const initialData = Route.useLoaderData();
  const [data, setData] = useState(initialData);
  const [greeting, setGreeting] = useState<string | null>(null);

  useEffect(() => {
    // Round-trips through the Effect API served by this same Worker:
    // src/site.ts owns /api/* and reads/writes R2 through a typed binding.
    (async () => {
      await fetch("/api/hello?key=welcome", {
        method: "PUT",
        body: "Hello from R2, via the Effect API!",
      });
      const res = await fetch("/api/hello?key=welcome");
      setGreeting(await res.text());
    })().catch(() => {});
  }, []);

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="m-0 text-3xl font-bold">TanStack Start</h1>
      <p className="mt-4 text-lg leading-relaxed">
        This is the minimal app scaffold in{" "}
        <code>examples/cloudflare-tanstack</code>.
      </p>
      <p className="mt-4 leading-relaxed">{data.message}</p>
      <p className="rounded-lg bg-slate-200 px-4 py-3 font-mono">{data.time}</p>
      <button
        type="button"
        onClick={async () => {
          setData(await getServerTime());
        }}
        className="cursor-pointer rounded-lg border-none bg-slate-900 px-4 py-3 text-white"
      >
        Refresh from server
      </button>
      <p className="mt-6 rounded-lg bg-slate-200 px-4 py-3 font-mono">
        {greeting ?? "Loading from /api/hello…"}
      </p>
    </main>
  );
}
