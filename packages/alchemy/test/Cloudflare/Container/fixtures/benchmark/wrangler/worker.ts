import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  BENCH_CONTAINER: DurableObjectNamespace<BenchContainer>;
}

/**
 * Plain `@cloudflare/containers` container — no Alchemy involved. The DO proxies
 * `fetch` to the Bun HTTP server on port 8080; the first `fetch` blocks through
 * the container's cold start (the helper calls `startAndWaitForPorts`
 * internally), so timing a single `fetch` measures start → reachable.
 */
export class BenchContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "2m";
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    // `/start?name=X` boots the container instance named `X` and reports the
    // cold-start-to-reachable latency measured inside the Worker.
    if (url.pathname === "/start") {
      const name = url.searchParams.get("name") ?? "default";
      const container = getContainer(env.BENCH_CONTAINER, name);
      const start = Date.now();
      try {
        const res = await container.fetch(new Request("http://container/"));
        await res.text();
        return Response.json({ ms: Date.now() - start, status: res.status });
      } catch (err) {
        return Response.json(
          { error: String(err), ms: Date.now() - start },
          { status: 500 },
        );
      }
    }

    return new Response("ok");
  },
} satisfies ExportedHandler<Env>;
