import { X509Certificate } from "node:crypto";
import * as net from "node:net";
import * as tls from "node:tls";
import { describe, expect, layer } from "alchemy-test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServer } from "effect/http/HttpServer";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { makeLocalCa } from "@/Egress/LocalCa.ts";
import { serveEgressControl, serveEgressProxy, writeTrustBundle } from "@/Egress/Proxy.ts";
import type { Route } from "@/Egress/Route.ts";
import { serveSandboxEgress } from "@/Runtime/Bootstrap/EgressProxy.ts";
import { httpServer, PlatformServices } from "@/Util/PlatformServices.ts";

interface Seen {
  readonly authorization: string | undefined;
  readonly target: string | undefined;
  readonly method: string | undefined;
}

/** Request headers the fake gateway never forwards to the target. */
const GATEWAY_ONLY = new Set([
  "authorization",
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding", // fetch would decompress, leaving a stale content-encoding
  "x-alchemy-target",
  "x-alchemy-method",
]);
const RESPONSE_DROP = new Set([
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
]);

/**
 * A fake egress gateway: records what the proxy sent, then either answers
 * itself (`gateway:<target>`) or forwards the request to its real target,
 * streaming both bodies.
 */
const fakeGateway = (mode: "answer" | "forward" | "drain") =>
  Effect.gen(function* () {
    const seen: Array<Seen> = [];
    const received = { bytes: 0 };
    const context = yield* Layer.build(
      httpServer(0, "127.0.0.1", { gracefulShutdownTimeout: 0 }).pipe(
        Layer.provideMerge(FetchHttpClient.layer),
      ),
    );
    const server = Context.get(context, HttpServer);
    const client = Context.get(context, HttpClient.HttpClient);
    yield* server.serve(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const target = request.headers["x-alchemy-target"];
        const method = request.headers["x-alchemy-method"];
        seen.push({ authorization: request.headers.authorization, target, method });
        if (mode === "drain") {
          yield* request.stream.pipe(
            Stream.runForEach((chunk) => Effect.sync(() => (received.bytes += chunk.length))),
          );
          return HttpServerResponse.text(`drained:${received.bytes}`);
        }
        if (mode === "answer" || !target || !method) {
          return HttpServerResponse.text(`gateway:${target}`);
        }
        const headers = Object.fromEntries(
          Object.entries(request.headers).filter(([name]) => !GATEWAY_ONLY.has(name)),
        );
        const outbound = HttpClientRequest.make(method as "GET")(target, { headers });
        const response = yield* client.execute(
          method === "GET" || method === "HEAD"
            ? outbound
            : outbound.pipe(
                HttpClientRequest.bodyStream(request.stream, {
                  contentType: request.headers["content-type"],
                }),
              ),
        );
        return HttpServerResponse.stream(response.stream, {
          status: response.status,
          headers: Object.fromEntries(
            Object.entries(response.headers).filter(([name]) => !RESPONSE_DROP.has(name)),
          ),
        });
      }).pipe(Effect.orDie),
    );
    const port = "port" in server.address ? server.address.port : 0;
    return { url: `http://127.0.0.1:${port}/`, seen, received };
  });

/** A proxy over `initial`, with a fresh CA and a trust bundle for curl/git. */
const startProxy = (initial: ReadonlyArray<Route>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const ca = yield* makeLocalCa;
    const routes = yield* SubscriptionRef.make(initial);
    const proxy = yield* serveEgressProxy({ port: 0, routes, ca });
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-egress-" });
    const bundle = path.join(dir, "bundle.pem");
    yield* writeTrustBundle(bundle, [ca.pem]);
    return { proxy, routes, bundle, dir };
  });

/**
 * The proxy in a process of its own (fixtures/proxy/server.ts), with `rss`
 * sampling that process alone. Killed when the scope closes.
 */
const spawnProxy = (initial: ReadonlyArray<Route>, bundle: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const [bun, script] = yield* Effect.sync(() => [
      process.execPath,
      path.join(import.meta.dirname, "fixtures", "proxy", "server.ts"),
    ]);
    const child = yield* spawner.spawn(
      ChildProcess.make(bun, [script, JSON.stringify(initial), bundle], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "inherit",
        extendEnv: true,
      }),
    );
    const line = yield* child.stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runHead,
      Effect.timeout("30 seconds"),
    );
    if (line._tag === "None")
      return yield* Effect.die(new Error("the proxy exited before listening"));
    const { url } = JSON.parse(line.value) as { url: string };
    /** The proxy process's resident memory, in bytes. */
    const rss = run("ps", ["-o", "rss=", "-p", String(child.pid)]).pipe(
      Effect.map((result) => Number(result.stdout.trim()) * 1024),
    );
    return { url, rss };
  });

const run = (command: string, args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(command, args, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env,
        extendEnv: true,
      }),
    );
    const { exitCode, stdout, stderr } = yield* Effect.all(
      {
        exitCode: child.exitCode,
        stdout: child.stdout.pipe(Stream.decodeText, Stream.mkString),
        stderr: child.stderr.pipe(Stream.decodeText, Stream.mkString),
      },
      { concurrency: "unbounded" },
    );
    return { code: Number(exitCode), stdout, stderr };
  }).pipe(Effect.scoped);

/** `curl` through the proxy; stdout is the body followed by ` [status]`. */
const curl = (
  proxyUrl: string,
  url: string,
  options: { readonly cacert?: string; readonly headers?: ReadonlyArray<string> } = {},
) =>
  run("curl", [
    "-sS",
    "--max-time",
    "30",
    "--proxy",
    proxyUrl,
    ...(options.cacert ? ["--cacert", options.cacert] : []),
    ...(options.headers ?? []).flatMap((header) => ["-H", header]),
    "-w",
    " [%{http_code}]",
    url,
  ]);

/**
 * The leaf the proxy presents for `host` (through `CONNECT`), unverified:
 * the caller checks which CA signed it.
 */
const leafThrough = (proxyUrl: string, host: string) =>
  Effect.callback<X509Certificate, Error>((resume) => {
    const { hostname, port } = new URL(proxyUrl);
    const socket = net.connect(Number(port), hostname, () =>
      socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`),
    );
    const fail = (cause: Error) => {
      socket.destroy();
      resume(Effect.fail(cause));
    };
    socket.once("error", fail);
    socket.once("data", (chunk: Buffer) => {
      const status = chunk.toString("latin1").split("\r\n")[0] ?? "";
      if (!status.includes(" 200 ")) return fail(new Error(status));
      const secure = tls.connect({ socket, servername: host, rejectUnauthorized: false }, () => {
        const cert = secure.getPeerX509Certificate();
        secure.destroy();
        if (!cert) return fail(new Error("no peer certificate"));
        resume(Effect.succeed(cert));
      });
      secure.once("error", fail);
    });
    return Effect.sync(() => socket.destroy());
  });

layer(PlatformServices, { excludeTestServices: true })("Egress.Proxy", (it) => {
  describe("routing", { tags: ["local"] }, () => {
    it.effect(
      "sends a routed host to its gateway with the grant and the target",
      () =>
        Effect.gen(function* () {
          const gateway = yield* fakeGateway("answer");
          const { proxy, bundle } = yield* startProxy([
            { host: "api.github.com", gateway: { id: "work", url: gateway.url }, grant: "g1" },
          ]);
          const result = yield* curl(proxy.url, "https://api.github.com/zen", {
            cacert: bundle,
            headers: ["Authorization: token alchemy-egress"],
          });
          expect(result.stderr).toBe("");
          expect(result.stdout).toBe("gateway:https://api.github.com/zen [200]");
          // The placeholder credential is replaced by the grant.
          expect(gateway.seen).toEqual([
            {
              authorization: "Macaroon g1",
              target: "https://api.github.com/zen",
              method: "GET",
            },
          ]);
        }),
      { timeout: 60_000 },
    );

    it.effect(
      "routes a host by path; an unmatched path goes straight out",
      () =>
        Effect.gen(function* () {
          const work = yield* fakeGateway("answer");
          const user = yield* fakeGateway("answer");
          const { proxy, bundle } = yield* startProxy([
            {
              host: "github.com",
              paths: ["/a/**"],
              gateway: { id: "work", url: work.url },
              grant: "gw",
            },
            {
              host: "github.com",
              paths: ["/b/**"],
              gateway: { id: "user", url: user.url },
              grant: "gu",
            },
          ]);
          const a = yield* curl(proxy.url, "https://github.com/a/x.git/info/refs", {
            cacert: bundle,
          });
          const b = yield* curl(proxy.url, "https://github.com/b/y?q=1", { cacert: bundle });
          const direct = yield* curl(proxy.url, "https://github.com/robots.txt", {
            cacert: bundle,
          });

          expect(a.stdout).toBe("gateway:https://github.com/a/x.git/info/refs [200]");
          expect(b.stdout).toBe("gateway:https://github.com/b/y?q=1 [200]");
          expect(work.seen.map((s) => [s.authorization, s.target])).toEqual([
            ["Macaroon gw", "https://github.com/a/x.git/info/refs"],
          ]);
          expect(user.seen.map((s) => [s.authorization, s.target])).toEqual([
            ["Macaroon gu", "https://github.com/b/y?q=1"],
          ]);
          // Real github.com, through the proxy's leaf, never a gateway.
          expect(direct.stdout).toContain("User-agent");
          expect(direct.stdout).toMatch(/\[200\]$/);
        }),
      { timeout: 90_000 },
    );

    it.effect(
      "tunnels an unrouted host without decrypting it",
      () =>
        Effect.gen(function* () {
          const gateway = yield* fakeGateway("answer");
          const { proxy } = yield* startProxy([
            { host: "api.github.com", gateway: { id: "work", url: gateway.url }, grant: "g1" },
          ]);
          // No --cacert: curl validates example.com's real certificate with the
          // system store, which fails if the proxy presented its own leaf.
          const result = yield* curl(proxy.url, "https://example.com/");
          expect(result.stderr).toBe("");
          expect(result.stdout).toContain("Example Domain");
          expect(result.stdout).toMatch(/\[200\]$/);
          expect(gateway.seen).toEqual([]);
        }),
      { timeout: 60_000 },
    );
  });

  describe("control endpoint", { tags: ["local"] }, () => {
    it.effect(
      "rejects a wrong secret; a new table applies to the next request",
      () =>
        Effect.gen(function* () {
          const gateway = yield* fakeGateway("answer");
          const { proxy, routes, bundle } = yield* startProxy([]);
          const control = yield* serveEgressControl({
            port: 0,
            host: "127.0.0.1",
            routes,
            secret: Redacted.make("s3cret"),
          });
          const client = yield* HttpClient.HttpClient;
          const table: ReadonlyArray<Route> = [
            { host: "example.com", gateway: { id: "work", url: gateway.url }, grant: "g2" },
          ];
          const put = (authorization?: string) =>
            client.execute(
              HttpClientRequest.put(`http://127.0.0.1:${control.port}/routes`).pipe(
                HttpClientRequest.setHeaders(authorization ? { authorization } : {}),
                HttpClientRequest.bodyJsonUnsafe(table),
              ),
            );

          const before = yield* curl(proxy.url, "https://example.com/", { cacert: bundle });
          expect(before.stdout).toContain("Example Domain");

          expect((yield* put("Bearer wrong")).status).toBe(401);
          expect((yield* put()).status).toBe(401);
          expect(yield* SubscriptionRef.get(routes)).toEqual([]);

          expect((yield* put("Bearer s3cret")).status).toBe(204);
          expect(yield* SubscriptionRef.get(routes)).toEqual(table);

          const after = yield* curl(proxy.url, "https://example.com/", { cacert: bundle });
          expect(after.stdout).toBe("gateway:https://example.com/ [200]");
          expect(gateway.seen.map((s) => s.authorization)).toEqual(["Macaroon g2"]);
        }).pipe(Effect.provide(FetchHttpClient.layer)),
      { timeout: 60_000 },
    );

    it.effect(
      "a MicroVM's run hook delivers the secret and the first table, once",
      () =>
        Effect.gen(function* () {
          const routes = yield* SubscriptionRef.make<ReadonlyArray<Route>>([]);
          const first: ReadonlyArray<Route> = [
            { host: "example.com", gateway: { id: "work", url: "https://gw" }, grant: "g1" },
          ];
          let ready = false;
          const control = yield* serveEgressControl({
            port: 0,
            host: "127.0.0.1",
            routes,
            hooks: {
              ready: Effect.sync(() => ready),
              run: (payload) =>
                Effect.gen(function* () {
                  const config = JSON.parse(payload ?? "{}") as {
                    secret: string;
                    routes: ReadonlyArray<Route>;
                  };
                  yield* SubscriptionRef.set(routes, config.routes);
                  return Redacted.make(config.secret);
                }),
            },
          });
          const client = yield* HttpClient.HttpClient;
          const base = `http://127.0.0.1:${control.port}`;
          const hook = (name: string, body: unknown = {}) =>
            client.execute(
              HttpClientRequest.post(`${base}/aws/lambda-microvms/runtime/v1/${name}`).pipe(
                HttpClientRequest.bodyJsonUnsafe(body),
              ),
            );
          const put = (authorization: string) =>
            client.execute(
              HttpClientRequest.put(`${base}/routes`).pipe(
                HttpClientRequest.setHeaders({ authorization }),
                HttpClientRequest.bodyJsonUnsafe([]),
              ),
            );

          expect((yield* hook("ready")).status).toBe(503);
          ready = true;
          expect((yield* hook("ready")).status).toBe(200);
          // No secret before the run hook: nothing can replace the table.
          expect((yield* put("Bearer s3cret")).status).toBe(401);

          const run = (secret: string) =>
            hook("run", {
              microvmId: "microvm-1",
              runHookPayload: JSON.stringify({ secret, routes: first }),
            });
          expect((yield* run("s3cret")).status).toBe(200);
          expect(yield* SubscriptionRef.get(routes)).toEqual(first);
          // Only Lambda's own (first) run hook is accepted.
          expect((yield* run("stolen")).status).toBe(409);
          expect((yield* put("Bearer stolen")).status).toBe(401);
          expect((yield* put("Bearer s3cret")).status).toBe(204);
          expect(yield* SubscriptionRef.get(routes)).toEqual([]);
        }).pipe(Effect.provide(FetchHttpClient.layer)),
      { timeout: 60_000 },
    );
  });

  describe("CA rotation", { tags: ["local"] }, () => {
    it.effect(
      "no CA refuses routed hosts; a replaced CA signs every new connection",
      () =>
        Effect.gen(function* () {
          const gateway = yield* fakeGateway("answer");
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-egress-" });
          const routes = yield* SubscriptionRef.make<ReadonlyArray<Route>>([
            { host: "api.github.com", gateway: { id: "work", url: gateway.url }, grant: "g1" },
          ]);
          const proxy = yield* serveEgressProxy({ port: 0, routes });

          // No CA: refused, and never sent straight out with the placeholder.
          const refused = yield* curl(proxy.url, "https://api.github.com/zen");
          expect(refused.stdout).not.toContain("gateway:");
          expect(refused.stderr).toContain("503");
          expect(gateway.seen).toEqual([]);

          const bundleFor = (name: string, pem: string) =>
            Effect.gen(function* () {
              const bundle = path.join(dir, `${name}.pem`);
              yield* writeTrustBundle(bundle, [pem]);
              return bundle;
            });
          const a = yield* makeLocalCa;
          const b = yield* makeLocalCa;
          const bundleA = yield* bundleFor("a", a.pem);
          const bundleB = yield* bundleFor("b", b.pem);
          const rootA = yield* Effect.sync(() => new X509Certificate(a.pem));
          const rootB = yield* Effect.sync(() => new X509Certificate(b.pem));

          yield* proxy.useCa(a);
          const withA = yield* curl(proxy.url, "https://api.github.com/zen", { cacert: bundleA });
          expect(withA.stdout).toBe("gateway:https://api.github.com/zen [200]");
          expect((yield* leafThrough(proxy.url, "api.github.com")).verify(rootA.publicKey)).toBe(
            true,
          );

          // The terminator (and leaf) cached for A is gone: B signs from now on.
          yield* proxy.useCa(b);
          const leaf = yield* leafThrough(proxy.url, "api.github.com");
          expect(leaf.verify(rootB.publicKey)).toBe(true);
          expect(leaf.verify(rootA.publicKey)).toBe(false);
          const staleTrust = yield* curl(proxy.url, "https://api.github.com/zen", {
            cacert: bundleA,
          });
          expect(staleTrust.stdout).not.toContain("gateway:");
          const withB = yield* curl(proxy.url, "https://api.github.com/zen", { cacert: bundleB });
          expect(withB.stdout).toBe("gateway:https://api.github.com/zen [200]");
        }),
      { timeout: 60_000 },
    );

    it.effect(
      "a MicroVM mints its own CA in the run hook, never at boot (snapshot) time",
      () =>
        Effect.gen(function* () {
          const gateway = yield* fakeGateway("answer");
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const client = yield* HttpClient.HttpClient;
          const route: Route = {
            host: "api.github.com",
            gateway: { id: "work", url: gateway.url },
            grant: "g1",
          };

          /** One MicroVM resumed from the snapshot: boot, then `/run`. */
          const microvm = (name: string) =>
            Effect.gen(function* () {
              const dir = yield* fs.makeTempDirectoryScoped({ prefix: `alchemy-egress-${name}-` });
              const caPath = path.join(dir, "ca.pem");
              const bundlePath = path.join(dir, "bundle.pem");
              const { proxy, controlPort } = yield* serveSandboxEgress({
                proxyPort: 0,
                controlPort: 0,
                controlHost: "127.0.0.1",
                caPath,
                bundlePath,
                // Ignored in run-hook mode: no routes until `/run`.
                routes: [route],
                runHook: true,
              });
              const run = () =>
                client.execute(
                  HttpClientRequest.post(
                    `http://127.0.0.1:${controlPort}/aws/lambda-microvms/runtime/v1/run`,
                  ).pipe(
                    HttpClientRequest.bodyJsonUnsafe({
                      runHookPayload: JSON.stringify({ secret: "s3cret", routes: [route] }),
                    }),
                  ),
                );
              return { proxy, caPath, bundlePath, run };
            });

          const first = yield* microvm("a");
          // Before `/run`: no CA anywhere, the bundle is the system roots
          // alone, and nothing is decrypted.
          expect(yield* fs.exists(first.caPath)).toBe(false);
          const bootBundle = yield* fs.readFileString(first.bundlePath);
          expect(bootBundle).not.toContain("Alchemy Egress");
          const early = yield* curl(first.proxy.url, "https://api.github.com/zen", {
            cacert: first.bundlePath,
          });
          expect(early.stdout).not.toContain("gateway:");
          expect(gateway.seen).toEqual([]);

          expect((yield* first.run()).status).toBe(200);
          const caA = yield* fs.readFileString(first.caPath);
          const bundleA = yield* fs.readFileString(first.bundlePath);
          // Rewritten in place: the same path now trusts this MicroVM's CA.
          expect(bundleA).toContain(caA.trim());
          expect(bundleA.startsWith(bootBundle.trim())).toBe(true);
          const rootA = yield* Effect.sync(() => new X509Certificate(caA));
          const leaf = yield* leafThrough(first.proxy.url, "api.github.com");
          expect(leaf.verify(rootA.publicKey)).toBe(true);
          const routed = yield* curl(first.proxy.url, "https://api.github.com/zen", {
            cacert: first.bundlePath,
          });
          expect(routed.stdout).toBe("gateway:https://api.github.com/zen [200]");

          // A second MicroVM of the same image: a CA of its own.
          const second = yield* microvm("b");
          expect((yield* second.run()).status).toBe(200);
          const caB = yield* fs.readFileString(second.caPath);
          expect(caB).not.toBe(caA);
          expect(
            (yield* leafThrough(second.proxy.url, "api.github.com")).verify(rootA.publicKey),
          ).toBe(false);
        }).pipe(Effect.provide(FetchHttpClient.layer)),
      { timeout: 60_000 },
    );
  });

  describe("streaming", { tags: ["local"] }, () => {
    it.effect(
      "git clone through a forwarding gateway",
      () =>
        Effect.gen(function* () {
          const gateway = yield* fakeGateway("forward");
          const { proxy, bundle, dir } = yield* startProxy([
            { host: "github.com", gateway: { id: "work", url: gateway.url }, grant: "g3" },
          ]);
          const path = yield* Path.Path;
          const fs = yield* FileSystem.FileSystem;
          const checkout = path.join(dir, "Hello-World");
          const result = yield* run(
            "git",
            ["clone", "--depth", "1", "https://github.com/octocat/Hello-World", checkout],
            {
              HTTPS_PROXY: proxy.url,
              https_proxy: proxy.url,
              GIT_SSL_CAINFO: bundle,
              GIT_TERMINAL_PROMPT: "0",
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
            },
          );
          expect(result.code, result.stderr).toBe(0);
          expect(yield* fs.exists(path.join(checkout, "README"))).toBe(true);
          expect(gateway.seen.length).toBeGreaterThan(0);
          for (const seen of gateway.seen) {
            expect(seen.authorization).toBe("Macaroon g3");
            expect(seen.target).toMatch(/^https:\/\/github\.com\/octocat\/Hello-World/);
          }
          // Both git smart-HTTP legs: the ref advertisement and the pack POST.
          expect(gateway.seen.map((s) => s.method)).toContain("POST");
        }),
      { timeout: 90_000 },
    );

    it.effect.skipIf(!!process.env.FAST)(
      "streams a large upload to the gateway without buffering it",
      () =>
        Effect.gen(function* () {
          const gateway = yield* fakeGateway("drain");
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-egress-" });
          const bundle = path.join(dir, "bundle.pem");
          // The proxy runs in its own process: the test process's memory moves
          // with whatever else the runner does (bundling, deploying).
          const proxy = yield* spawnProxy(
            [{ host: "uploads.example", gateway: { id: "work", url: gateway.url }, grant: "g4" }],
            bundle,
          );
          // Under Bun.serve's default 128 MiB request limit (the fake gateway's, not the proxy's).
          const size = 120 * 1024 * 1024;
          const file = path.join(dir, "upload.bin");
          // Sparse: no disk or memory spent on the source.
          yield* fs.writeFile(file, new Uint8Array(0));
          yield* fs.truncate(file, size);

          const baseline = yield* proxy.rss;
          expect(baseline).toBeGreaterThan(0);
          let peak = baseline;
          const sampler = yield* proxy.rss.pipe(
            Effect.tap((value) => Effect.sync(() => (peak = Math.max(peak, value)))),
            Effect.repeat(Schedule.spaced("50 millis")),
            Effect.forkChild,
          );
          // `uploads.example` never resolves: the request must reach the gateway.
          const result = yield* run("curl", [
            "-sS",
            "--max-time",
            "60",
            "--proxy",
            proxy.url,
            "--cacert",
            bundle,
            "-T",
            file,
            "-w",
            " [%{http_code}]",
            "https://uploads.example/upload",
          ]);
          yield* Fiber.interrupt(sampler);

          expect(result.stderr).toBe("");
          expect(result.stdout).toBe(`drained:${size} [200]`);
          expect(gateway.seen.map((s) => s.method)).toEqual(["PUT"]);
          // Buffered, the body alone would add 120 MiB to the proxy's process.
          expect(peak - baseline).toBeLessThan(64 * 1024 * 1024);
        }),
      { timeout: 90_000 },
    );
  });
});
