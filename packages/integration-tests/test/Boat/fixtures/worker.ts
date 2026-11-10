import * as Boat from "@alchemy.run/boat";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { BindingBox } from "./resources.ts";

const ECHO_PORT = 8000;

/**
 * Answers every request with 201, an `x-echo` header, and what it received:
 * method, path, query, the `x-probe` header and the body.
 */
const ECHO_SERVER = `
import http.server, json, urllib.parse

class Echo(http.server.BaseHTTPRequestHandler):
    def body(self):
        if self.headers.get("transfer-encoding", "").lower() == "chunked":
            data = b""
            while True:
                size = int(self.rfile.readline().strip(), 16)
                if size == 0:
                    self.rfile.readline()
                    return data
                data += self.rfile.read(size)
                self.rfile.readline()
        return self.rfile.read(int(self.headers.get("content-length") or 0))

    def echo(self):
        url = urllib.parse.urlsplit(self.path)
        out = json.dumps({
            "method": self.command,
            "path": url.path,
            "query": dict(urllib.parse.parse_qsl(url.query)),
            "probe": self.headers.get("x-probe"),
            "body": self.body().decode(),
        }).encode()
        self.send_response(201)
        self.send_header("content-type", "application/json")
        self.send_header("x-echo", "sandbox")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    do_GET = do_POST = do_PUT = echo

http.server.ThreadingHTTPServer(("0.0.0.0", ${ECHO_PORT}), Echo).serve_forever()
`;

const decoder = new TextDecoder();

const BindingsLive = Layer.mergeAll(Boat.CreateSandboxHttp, Boat.ConnectSandboxHttp);

export default class BoatWorker extends Cloudflare.Worker<BoatWorker>()(
  "BoatWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const sandboxes = yield* Boat.CreateSandbox();
    const box = yield* Boat.ConnectSandbox(BindingBox);

    /** A small sandbox with none of the account's secrets, deleted when the request ends. */
    const scopedSandbox = (options?: Boat.CreateSandboxOptions) =>
      Effect.acquireRelease(
        sandboxes.create({ type: "small", noEnv: true, autoStop: "10 minutes", ...options }),
        (sandbox) => Effect.ignore(sandbox.delete()),
      );

    /**
     * Starts the echo server in a sandbox and waits until its port answers.
     * The sandbox outlives the request, so a later request can proxy to it.
     */
    const openEchoSandbox = Effect.gen(function* () {
      const sandbox = yield* sandboxes.create({
        type: "small",
        noEnv: true,
        autoStop: "10 minutes",
      });
      return yield* Effect.gen(function* () {
        yield* sandbox.files.write("/home/user/echo.py", ECHO_SERVER);
        yield* sandbox.start("python3 /home/user/echo.py");
        const port = yield* sandbox.getTcpPort(ECHO_PORT);
        yield* port.fetch(HttpClientRequest.get("/ready")).pipe(
          Effect.flatMap((res) =>
            res.status === 201 ? Effect.void : Effect.fail(new Error(`status ${res.status}`)),
          ),
          Effect.retry({ schedule: Schedule.spaced("1 second"), times: 20 }),
        );
        return { sandbox, port };
      }).pipe(Effect.onError(() => Effect.ignore(sandbox.delete())));
    });

    const routes: Record<string, (query: URLSearchParams) => Effect.Effect<unknown, unknown, any>> =
      {
        // What the bindings bound next to their keys: the deployer's org
        // and API URL, which every Boat call from here sends.
        "/boat/account": () =>
          Effect.gen(function* () {
            const env = (yield* Cloudflare.WorkerEnvironment) as Record<string, unknown>;
            return { org: env.BOAT_ORG, apiBaseUrl: env.BOAT_API_BASE_URL };
          }),
        // getTcpPort: a client request to the echo server. The sandbox is
        // kept for the proxy test, which deletes it.
        "/ports/open": () =>
          Effect.gen(function* () {
            const { sandbox, port } = yield* openEchoSandbox;
            const res = yield* port.fetch(
              HttpClientRequest.post("/echo/client?a=1&b=two").pipe(
                HttpClientRequest.setHeader("x-probe", "client"),
                HttpClientRequest.bodyText("client body", "text/plain"),
              ),
            );
            return {
              sandboxId: sandbox.sandboxId,
              url: port.url,
              protected: port.token !== undefined,
              status: res.status,
              echoHeader: res.headers["x-echo"],
              echoed: yield* res.json,
            };
          }),
        "/ports/close": (query) =>
          sandboxes.delete(query.get("sandbox") ?? "").pipe(Effect.as({ closed: true })),
        // Commands, background processes and files in a fresh sandbox.
        "/sandbox/commands": () =>
          Effect.gen(function* () {
            const sandbox = yield* scopedSandbox();
            const ok = yield* sandbox.exec("echo out; echo err >&2");
            const failed = yield* sandbox.exec("exit 3");
            const argv = yield* sandbox.exec(["printf", "%s|%s", "it's", "two words"]);
            const fed = yield* sandbox.exec("cat", { stdin: "fed via stdin" });
            const withEnv = yield* sandbox.exec("echo $GREETING", {
              env: { GREETING: "hi 'there'" },
            });
            const inTmp = yield* sandbox.exec("pwd", { cwd: "/tmp" });
            const timedOut = yield* sandbox.exec("sleep 5", { timeout: "1 second" }).pipe(
              Effect.flip,
              Effect.map((e) => e._tag),
            );

            yield* sandbox.files.write("/tmp/files/a.txt", "hello");
            yield* sandbox.files.write("/tmp/files/bin.dat", new Uint8Array([0, 1, 2, 255]));
            const read = yield* sandbox.files.readText("/tmp/files/a.txt");
            const bytes = Array.from(yield* sandbox.files.read("/tmp/files/bin.dat"));
            const listed = (yield* sandbox.files.list("/tmp/files")).map((entry) => entry.path);
            const stat = yield* sandbox.files.stat("/tmp/files/a.txt");
            yield* sandbox.files.makeDir("/tmp/files/sub/deeper");
            yield* sandbox.files.move("/tmp/files/a.txt", "/tmp/files/sub/b.txt");
            const movedExists = yield* sandbox.files.exists("/tmp/files/sub/b.txt");
            yield* sandbox.files.remove("/tmp/files/sub");
            const removedExists = yield* sandbox.files.exists("/tmp/files/sub/b.txt");
            const missing = yield* sandbox.files.readText("/tmp/files/missing.txt").pipe(
              Effect.flip,
              Effect.map((e) => e._tag),
            );

            const proc = yield* sandbox.start(
              "for i in 1 2 3; do echo line$i; sleep 1; done; echo oops >&2; exit 4",
            );
            const chunks = yield* proc.output.pipe(Stream.runCollect);
            const finished = yield* proc.wait;
            const sleeper = yield* sandbox.start("sleep 300");
            yield* sleeper.kill();
            const killed = yield* sleeper.wait;

            return {
              ok,
              failedExitCode: failed.exitCode,
              argv: argv.stdout,
              fed: fed.stdout,
              withEnv: withEnv.stdout,
              inTmp: inTmp.stdout,
              timedOut,
              read,
              bytes,
              listed,
              statSize: stat.size,
              statType: stat.type,
              movedExists,
              removedExists,
              missing,
              streamed: {
                stdout: Array.from(chunks)
                  .filter((chunk) => chunk.fd === "stdout")
                  .map((chunk) => decoder.decode(chunk.data))
                  .join(""),
                stderr: Array.from(chunks)
                  .filter((chunk) => chunk.fd === "stderr")
                  .map((chunk) => decoder.decode(chunk.data))
                  .join(""),
                exitCode: finished.exitCode,
              },
              killedExitCode: killed.exitCode,
            };
          }),
        // Labels, list, stop, resume, fork and delete.
        "/sandbox/lifecycle": (query) =>
          Effect.gen(function* () {
            const task = query.get("task") ?? "";
            const sandbox = yield* scopedSandbox({ labels: { task } });
            yield* sandbox.files.write("note.txt", "from parent");
            const found = yield* sandboxes.list({ labels: { task } });
            yield* sandbox.stop();
            yield* sandbox.stop();
            const stopped = yield* sandbox.describe().pipe(
              Effect.repeat({
                schedule: Schedule.spaced("2 seconds"),
                until: (info) => info.state === "archived",
                times: 30,
              }),
            );
            const notRunning = yield* sandbox.exec("true").pipe(
              Effect.flip,
              Effect.map((e) => e._tag),
            );
            // `archived` can show before the stop's snapshot completes.
            const fork = yield* Effect.acquireRelease(
              sandbox.fork({ type: "small", autoStop: "5 minutes" }).pipe(
                Effect.retry({
                  while: (e) => e._tag === "ForkNeedsSnapshot",
                  schedule: Schedule.spaced("2 seconds"),
                  times: 15,
                }),
              ),
              (forked) => Effect.ignore(forked.delete()),
            );
            const forkNote = yield* fork.files
              .readText("note.txt")
              .pipe(Effect.retry({ schedule: Schedule.spaced("1 second"), times: 20 }));
            yield* sandbox.resume({ autoStop: "10 minutes" });
            const resumed = yield* sandbox
              .exec("cat note.txt")
              .pipe(Effect.retry({ schedule: Schedule.spaced("1 second"), times: 20 }));
            return {
              sandboxId: sandbox.sandboxId,
              labels: sandbox.info.labels,
              forkLabels: fork.info.labels,
              foundIds: found.map((s) => s.id),
              stoppedState: stopped.state,
              notRunning,
              forkNote,
              resumed: resumed.stdout,
            };
          }),
        // The declared sandbox, through ConnectSandbox.
        "/box": () =>
          Effect.gen(function* () {
            yield* box.resume({ autoStop: "30 minutes" });
            yield* box.files.write("visits.txt", "1");
            const ran = yield* box.exec("cat visits.txt; hostname");
            const info = yield* box.describe();
            return { sandboxId: yield* box.sandboxId, stdout: ran.stdout, state: info.state };
          }),
      };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        // getTcpPort: proxy this request, as received, to the echo server
        // in the sandbox named by `x-sandbox-id`.
        if (url.pathname.startsWith("/proxy/")) {
          return yield* Effect.gen(function* () {
            const sandbox = yield* sandboxes.connect(request.headers["x-sandbox-id"] ?? "");
            const port = yield* sandbox.getTcpPort(ECHO_PORT);
            return yield* port.fetch(request);
          }).pipe(
            Effect.catchCause((cause) =>
              HttpServerResponse.json({ error: String(cause) }, { status: 500 }),
            ),
          );
        }
        const route = routes[url.pathname];
        if (route === undefined) return HttpServerResponse.text("not found", { status: 404 });
        return yield* route(url.searchParams).pipe(
          Effect.scoped,
          Effect.flatMap((body) => HttpServerResponse.json(body)),
          Effect.catchCause((cause) =>
            HttpServerResponse.json({ error: String(cause) }, { status: 500 }),
          ),
        );
      }),
    };
  }).pipe(Effect.provide(BindingsLive)),
) {}
