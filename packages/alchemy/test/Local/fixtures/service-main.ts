// A minimal long-running local service: serves `ok:{MARKER}` on PORT.
// Run by Local.Service tests via `bun <main>` — no imports, no build.
Bun.serve({
  port: Number(process.env.PORT ?? 0),
  fetch: () =>
    new Response(`ok:${process.env.MARKER ?? ""}`, {
      headers: { "content-type": "text/plain" },
    }),
});

console.log(`service-main listening on ${process.env.PORT}`);
