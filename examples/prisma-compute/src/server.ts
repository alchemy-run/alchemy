const port = Number(process.env.PORT ?? "8080");
const greeting = process.env.GREETING ?? "hello";

const server = Bun.serve({
  port,
  routes: {
    "/": new Response(greeting),
    "/health": Response.json({ ok: true }),
  },
});

console.log(`Listening on ${server.url}`);
