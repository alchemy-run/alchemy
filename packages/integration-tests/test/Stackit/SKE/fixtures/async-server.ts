// An ordinary Bun server with no Effect runtime: the async form of a workload.
// Only the deployed container runs this file.
Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  fetch: () => new Response(process.env.GREETING ?? "no greeting"),
});
