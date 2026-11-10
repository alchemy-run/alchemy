// A program for lifecycle tests: answers every call with its VERSION.
Bun.serve({
  port: Number(process.env.PORT),
  hostname: "0.0.0.0",
  fetch: () => Response.json({ version: process.env.VERSION }),
});
