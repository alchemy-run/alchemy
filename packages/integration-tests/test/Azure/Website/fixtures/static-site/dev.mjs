// The fixture's long-lived dev server: serves src/ on an ephemeral port and
// prints its URL, which `Command.Dev` reads from stdout. `/__dev-env` echoes
// DEV_MARKER so a test can prove `dev.env` reached the child process.
// Plain .mjs so the test project never type-checks it; it runs under bun.
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/__dev-env") {
      return Response.json({ marker: process.env.DEV_MARKER ?? null });
    }
    const file = Bun.file(
      `${process.cwd()}/src${pathname.endsWith("/") ? `${pathname}index.html` : pathname}`,
    );
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});

console.log(`Static site fixture dev server: http://127.0.0.1:${server.port}`);
