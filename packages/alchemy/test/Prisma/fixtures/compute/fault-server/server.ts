/**
 * Fault-injection Compute app. The Compute's env chooses its behavior, so one
 * fixture covers healthy, crashing, and unhealthy deployments:
 *
 * - `CRASH_ON_BOOT`: exit 1 before listening.
 * - `HEALTH_STATUS`: status of `/health/<GREETING>` (default 200).
 * - `STABLE_HEALTH_STATUS`: status of `/health/<GREETING>` on the App
 *   endpoint. Prisma serves a deployment preview on a `cv-` host.
 *
 * `/health/<tag>` answers 404 when `<tag>` is not this deployment's
 * `GREETING`, so a probe that still reaches the previous generation never
 * passes for the new one. `/` answers `GREETING` and `/env?key=K` answers the
 * runtime value of `K`. Every request is logged.
 */
const env = process.env;
const greeting = env["GREETING"] ?? "missing";

if (env["CRASH_ON_BOOT"]) {
  console.error("fault-server crashing on boot");
  process.exit(1);
}

const healthResponse = (status: number) =>
  status >= 300 && status < 400
    ? new Response(null, { status, headers: { location: "/" } })
    : new Response(status === 204 ? null : `health ${status}`, { status });

const server = Bun.serve({
  port: Number(env["PORT"] ?? "8080"),
  fetch(request) {
    const url = new URL(request.url);
    const host = request.headers.get("host") ?? url.host;
    console.log(`fault-server ${greeting} ${request.method} ${url.pathname}`);
    if (url.pathname.startsWith("/health/")) {
      if (url.pathname !== `/health/${greeting}`)
        return new Response("other generation", { status: 404 });
      const stable = env["STABLE_HEALTH_STATUS"];
      return healthResponse(
        Number(
          !host.startsWith("cv-") && stable !== undefined
            ? stable
            : (env["HEALTH_STATUS"] ?? "200"),
        ),
      );
    }
    if (url.pathname === "/env") {
      return new Response(env[url.searchParams.get("key") ?? ""] ?? "missing");
    }
    return new Response(greeting);
  },
});

console.log(`fault-server ${greeting} listening on ${server.port}`);

export {};
