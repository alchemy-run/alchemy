import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { BindingAgent, BindingBox, ProbeWebhook, RotatedSecret } from "./resources.ts";

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

const BindingsLive = Layer.mergeAll(
  E2B.CreateSandboxHttp,
  E2B.ConnectSandboxHttp,
  E2B.CreateSecretHttp,
  E2B.CreateTemplateHttp,
  E2B.CreateSnapshotHttp,
  E2B.WriteSecretHttp,
  E2B.ReadTeamHttp,
  E2B.ReadWebhookHttp,
);

export default class E2BWorker extends Cloudflare.Worker<E2BWorker>()(
  "E2BWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const sandboxes = yield* E2B.CreateSandbox(BindingAgent);
    const anySandboxes = yield* E2B.CreateSandbox();
    const declaredBox = yield* BindingBox;
    const box = yield* E2B.ConnectSandbox(declaredBox);
    const secrets = yield* E2B.CreateSecret();
    const templates = yield* E2B.CreateTemplate();
    const snapshots = yield* E2B.CreateSnapshot();
    const rotate = yield* E2B.WriteSecret(RotatedSecret);
    const team = yield* E2B.ReadTeam();
    const probe = yield* E2B.ReadWebhook(ProbeWebhook);

    /** A sandbox from the bound template, killed when the request ends. */
    const scopedSandbox = (options?: E2B.CreateSandboxOptions) =>
      Effect.acquireRelease(sandboxes.create({ timeout: 300, ...options }), (sandbox) =>
        Effect.ignore(sandbox.kill()),
      );

    /**
     * Starts the echo server in a sandbox and waits until its port answers.
     * The sandbox outlives the request, so a later request can proxy to it.
     */
    const openEchoSandbox = Effect.gen(function* () {
      const sandbox = yield* sandboxes.create({ timeout: 300 });
      return yield* Effect.gen(function* () {
        yield* sandbox.files.write("/home/user/echo.py", ECHO_SERVER);
        yield* sandbox.exec("nohup python3 /home/user/echo.py >/dev/null 2>&1 &");
        const port = yield* sandbox.getTcpPort(ECHO_PORT);
        yield* port.fetch(HttpClientRequest.get("/ready")).pipe(
          Effect.flatMap((res) =>
            res.status === 201 ? Effect.void : Effect.fail(new Error(`status ${res.status}`)),
          ),
          Effect.retry({ schedule: Schedule.spaced("1 second"), times: 20 }),
        );
        return { sandbox, port };
      }).pipe(Effect.onError(() => Effect.ignore(sandbox.kill())));
    });

    const routes: Record<string, (query: URLSearchParams) => Effect.Effect<unknown, unknown, any>> =
      {
        // getTcpPort: a client request to the echo server. The sandbox is
        // kept for the proxy test, which closes it.
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
              host: port.host,
              url: port.url,
              status: res.status,
              echoHeader: res.headers["x-echo"],
              echoed: yield* res.json,
            };
          }),
        "/ports/close": (query) =>
          sandboxes.kill(query.get("sandbox") ?? "").pipe(Effect.as({ closed: true })),
        // CreateSandbox(base): commands and files through envd.
        "/sandbox/commands": () =>
          Effect.gen(function* () {
            const sandbox = yield* scopedSandbox();
            const marker = yield* sandbox.files.readText("/home/user/marker.txt");
            const ok = yield* sandbox.exec("echo out; echo err >&2");
            const failed = yield* sandbox.exec("exit 3");
            const exec = yield* sandbox.exec(["printf", "%s", "argv"]);
            const fed = yield* sandbox.exec("cat", { stdin: "fed via stdin" });
            const withEnv = yield* sandbox.exec("echo $GREETING", {
              env: { GREETING: "hi" },
              cwd: "/tmp",
            });
            const timedOut = yield* sandbox.exec("sleep 30", { timeout: "2 seconds" }).pipe(
              Effect.map(() => "finished"),
              Effect.catchTag("E2B.ExecTimedOut", (error) => Effect.succeed(error._tag)),
            );
            yield* sandbox.files.write("/home/user/dir/a.txt", "hello");
            const read = yield* sandbox.files.readText("/home/user/dir/a.txt");
            const listed = yield* sandbox.files.list("/home/user/dir");
            yield* sandbox.files.move("/home/user/dir/a.txt", "/home/user/dir/b.txt");
            const movedExists = yield* sandbox.files.exists("/home/user/dir/b.txt");
            yield* sandbox.files.remove("/home/user/dir/b.txt");
            const removedExists = yield* sandbox.files.exists("/home/user/dir/b.txt");
            const streamed = yield* Effect.scoped(
              Effect.gen(function* () {
                const proc = yield* sandbox.start("echo streamed; echo oops >&2");
                const output = yield* proc.output.pipe(
                  Stream.map((chunk) => chunk.fd),
                  Stream.runCollect,
                );
                const result = yield* proc.wait;
                return {
                  output: Array.from(output),
                  stdout: result.stdout,
                  exitCode: result.exitCode,
                };
              }),
            );
            return {
              templateId: sandbox.templateId,
              marker,
              ok,
              failedExitCode: failed.exitCode,
              exec: exec.stdout,
              fed: fed.stdout,
              withEnv: withEnv.stdout,
              timedOut,
              read,
              listed: listed.map((entry) => entry.name),
              movedExists,
              removedExists,
              streamed,
            };
          }),
        // CreateSandbox(base): lifecycle — metadata lookup, pause, resume, timeout, kill.
        "/sandbox/lifecycle": (query) =>
          Effect.gen(function* () {
            const task = query.get("task") ?? "lifecycle";
            const sandbox = yield* sandboxes.create({ timeout: 300, metadata: { task } });
            yield* sandbox.files.write("/home/user/state.txt", "kept");
            const found = yield* sandboxes.list({ metadata: { task } });
            yield* sandbox.setTimeout("10 minutes");
            yield* sandbox.pause();
            const paused = yield* sandboxes.get(sandbox.sandboxId);
            const notRunning = yield* sandbox.files.readText("/home/user/state.txt").pipe(
              Effect.map(() => "read"),
              Effect.catchTag("SandboxNotRunning", (error) => Effect.succeed(error._tag)),
            );
            const resumed = yield* sandboxes.connect(sandbox.sandboxId, { timeout: 300 });
            const state = yield* resumed.files.readText("/home/user/state.txt");
            const detail = yield* resumed.describe();
            yield* resumed.kill();
            const killedAgain = yield* sandboxes.kill(sandbox.sandboxId).pipe(Effect.as("ok"));
            return {
              foundIds: found.map((s) => s.sandboxID),
              sandboxId: sandbox.sandboxId,
              pausedState: paused.state,
              notRunning,
              resumedState: detail.state,
              metadata: detail.metadata,
              state,
              killedAgain,
            };
          }),
        // The sandbox handle: processes, stdin, PTYs, files, ports, logs, network.
        "/sandbox/handle": () =>
          Effect.gen(function* () {
            const sandbox = yield* scopedSandbox();
            const text = (data: Uint8Array) => new TextDecoder().decode(data);

            // Files: mkdir, compose, read bytes, stat, watch.
            yield* sandbox.files.makeDir("/home/user/h");
            yield* sandbox.files.write("/home/user/h/a.txt", "a");
            yield* sandbox.files.write("/home/user/h/b.txt", "b");
            yield* sandbox.files.compose(
              ["/home/user/h/a.txt", "/home/user/h/b.txt"],
              "/home/user/h/ab.txt",
            );
            const composed = new TextDecoder().decode(
              yield* sandbox.files.read("/home/user/h/ab.txt"),
            );
            const stat = yield* sandbox.files.stat("/home/user/h/ab.txt");
            const watcher = yield* sandbox.files.watch("/home/user/h").pipe(
              Stream.filter((event) => event._tag === "Filesystem"),
              Stream.take(1),
              Stream.runCollect,
              Effect.forkScoped,
            );
            yield* Effect.sleep("1 second");
            yield* sandbox.files.write("/home/user/h/watched.txt", "w");
            const watched = yield* Fiber.join(watcher).pipe(Effect.timeout("20 seconds"));

            // Processes: stdin, list, re-attach, close stdin, kill.
            const cat = yield* sandbox.start("cat", { tag: "cat", stdin: true });
            const catOutput = yield* cat.output.pipe(
              Stream.map((chunk) => text(chunk.data)),
              Stream.mkString,
              Effect.forkScoped,
            );
            const reattached = yield* sandbox.processes.attach({ tag: "cat" });
            const reattachedOutput = yield* reattached.output.pipe(
              Stream.map((chunk) => text(chunk.data)),
              Stream.mkString,
              Effect.forkScoped,
            );
            yield* Effect.sleep("500 millis");
            const running = yield* sandbox.processes.list();
            yield* cat.write("ping\n");
            yield* cat.closeStdin();
            const catOut = yield* Fiber.join(catOutput).pipe(Effect.timeout("20 seconds"));
            const catExit = yield* cat.wait.pipe(Effect.timeout("20 seconds"));
            const reattachedOut = yield* Fiber.join(reattachedOutput).pipe(
              Effect.timeout("20 seconds"),
            );
            // Detaching (closing its scope) leaves the process running.
            const sleeperPid = yield* Effect.scoped(
              Effect.map(sandbox.start("sleep 300", { tag: "sleeper" }), (proc) => proc.pid),
            );
            const afterDetach = yield* sandbox.processes.list();
            const sleeper = yield* sandbox.processes.attach({ pid: sleeperPid });
            yield* sleeper.kill();
            const sleeperExit = yield* sleeper.wait.pipe(Effect.timeout("20 seconds"));
            const afterKill = yield* sandbox.processes.list();

            // A PTY: type, resize, read the output.
            const pty = yield* sandbox.pty.open({ cols: 80, rows: 24 });
            const ptyOutput = yield* pty.output.pipe(
              Stream.map(text),
              Stream.mkString,
              Effect.forkScoped,
            );
            yield* Effect.sleep("1 second");
            yield* pty.resize({ cols: 100, rows: 30 });
            yield* pty.write("echo pty-$((6*7)); stty size; exit\n");
            const ptyOut = yield* Fiber.join(ptyOutput).pipe(Effect.timeout("20 seconds"));
            const ptyExit = yield* pty.wait.pipe(Effect.timeout("20 seconds"));

            // Lifetime, network, logs.
            yield* sandbox.refresh("1 minute");
            yield* sandbox.updateNetwork({ allowOut: ["github.com"] });
            const detail = yield* sandbox.describe();
            const logs = yield* sandbox.logs({ limit: 10 });

            return {
              composed,
              statName: stat.name,
              watched: Array.from(watched).map((event) =>
                event._tag === "Filesystem" ? event.name : "",
              ),
              listedCat: running.some((p) => p.tag === "cat"),
              catOut,
              catExitCode: catExit.exitCode,
              reattachedOut,
              sleeperDetached: afterDetach.some((p) => p.pid === sleeperPid),
              sleeperKilled: !afterKill.some((p) => p.pid === sleeperPid),
              sleeperExitCode: sleeperExit.exitCode,
              ptyOut,
              ptyExitCode: ptyExit.exitCode,
              allowOut: detail.network?.allowOut ?? [],
              logs: logs.logs.length,
            };
          }),
        // ConnectSandbox: the declared sandbox's handle.
        "/box/run": () =>
          Effect.gen(function* () {
            yield* box.resume({ timeout: "5 minutes" });
            const marker = yield* box.files.readText("/home/user/marker.txt");
            yield* box.files.write("/home/user/box-state.txt", "kept");
            const echoed = yield* box.exec(["echo", "from the box"]);
            const sandboxId = yield* box.sandboxId;
            const port = yield* box.getTcpPort(3000);
            return { sandboxId, marker, echoed: echoed.stdout, url: port.url, host: port.host };
          }),
        // A paused sandbox fails envd calls with a typed tag until resumed.
        "/box/pause": () =>
          Effect.gen(function* () {
            yield* box.pause();
            const paused = yield* box.describe();
            const whilePaused = yield* box.files.readText("/home/user/box-state.txt").pipe(
              Effect.map(() => "read"),
              Effect.catchTag("SandboxNotRunning", (error) => Effect.succeed(error._tag)),
            );
            yield* box.resume({ timeout: "5 minutes" });
            const state = yield* box.files.readText("/home/user/box-state.txt");
            const detail = yield* box.describe();
            return {
              pausedState: paused.state,
              whilePaused,
              resumedState: detail.state,
              state,
            };
          }),
        // CreateSandbox.metrics: several sandboxes in one call.
        "/sandbox/metrics": () =>
          Effect.gen(function* () {
            const sandbox = yield* scopedSandbox();
            // E2B reports a new sandbox's first metrics after a few seconds.
            const metrics = yield* sandboxes.metrics([sandbox.sandboxId]).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("2 seconds"),
                until: (m) => m.sandboxes[sandbox.sandboxId] !== undefined,
                times: 15,
              }),
            );
            return { sandboxId: sandbox.sandboxId, ids: Object.keys(metrics.sandboxes) };
          }),
        // Fork: the copy sees the parent's files.
        "/sandbox/fork": () =>
          Effect.gen(function* () {
            const sandbox = yield* scopedSandbox();
            yield* sandbox.files.write("/home/user/forked.txt", "from parent");
            const [result] = yield* sandbox.fork({ count: 1, timeout: "5 minutes" });
            if (result?._tag !== "Forked") return { error: result };
            const content = yield* result.sandbox.files.readText("/home/user/forked.txt");
            yield* result.sandbox.kill();
            return { parent: sandbox.sandboxId, fork: result.sandbox.sandboxId, content };
          }),
        // sandbox.snapshot + create from it + CreateSnapshot list/delete.
        "/sandbox/snapshot": (query) =>
          Effect.gen(function* () {
            const name = query.get("name") ?? "alchemy-binding-snapshot";
            const sandbox = yield* scopedSandbox();
            yield* sandbox.files.write("/home/user/snap.txt", "snapshotted");
            const snapshot = yield* sandbox.snapshot({ name });
            const listed = yield* snapshots.list({ name });
            const restored = yield* Effect.acquireRelease(
              anySandboxes.create({ templateID: snapshot.snapshotID, timeout: 300 }),
              (s) => Effect.ignore(s.kill()),
            );
            const content = yield* restored.files.readText("/home/user/snap.txt");
            // E2B keeps a snapshot while a sandbox runs on it.
            yield* restored.kill();
            yield* snapshots.delete(name);
            return { snapshotId: snapshot.snapshotID, listed: listed.length, content };
          }),
        // CreateSnapshot.create: boot, set up, snapshot, kill.
        "/snapshots": (query) =>
          Effect.gen(function* () {
            const name = query.get("name") ?? "alchemy-binding-warm";
            const info = yield* snapshots.create(name, {
              template: query.get("template") ?? "base",
              run: ["echo warm > /home/user/warm.txt"],
            });
            const sandbox = yield* Effect.acquireRelease(
              anySandboxes.create({ templateID: info.snapshotID, timeout: 300 }),
              (s) => Effect.ignore(s.kill()),
            );
            const content = yield* sandbox.files.readText("/home/user/warm.txt");
            yield* sandbox.kill();
            yield* snapshots.delete(name);
            return { content };
          }),
        // CreateSecret: a runtime secret injected at egress, never visible in the sandbox.
        "/secrets": (query) =>
          Effect.gen(function* () {
            const name = query.get("name") ?? "alchemy-binding-secret";
            const value = "s3cr3t-value";
            const secret = yield* secrets.put(name, Redacted.make(value));
            const listed = yield* secrets.list();
            const sandbox = yield* scopedSandbox({
              network: {
                allowOut: ["postman-echo.com"],
                rules: {
                  "postman-echo.com": [
                    { transform: { headers: { "X-Alchemy-Secret": secret.ref } } },
                  ],
                },
              },
            });
            const echoed = yield* sandbox.exec("curl -s https://postman-echo.com/headers");
            const env = yield* sandbox.exec("env");
            yield* secrets.delete(name);
            const gone = yield* secrets.get(name);
            return {
              ref: secret.ref,
              listed: listed.some((s) => s.name === secret.name),
              injected: echoed.stdout.includes(value),
              leaked: env.stdout.includes(value),
              gone: gone === undefined,
            };
          }),
        // WriteSecret: rotate a declared secret.
        "/rotate": () =>
          Effect.gen(function* () {
            const first = yield* rotate.put(Redacted.make("second"));
            const second = yield* rotate.put(Redacted.make("third"));
            return { first: first.version, second: second.version };
          }),
        // CreateTemplate: a runtime build, then the cached build.
        "/templates": (query) =>
          Effect.gen(function* () {
            const name = query.get("name") ?? "alchemy-binding-template";
            const spec = {
              name,
              fromTemplate: "base",
              files: [{ path: "/home/user/greeting.txt", contents: "built at runtime" }],
            };
            const first = yield* templates.getOrBuild(spec);
            const second = yield* templates.getOrBuild(spec);
            const sandbox = yield* Effect.acquireRelease(
              anySandboxes.create({ templateID: first.templateId, timeout: 300 }),
              (s) => Effect.ignore(s.kill()),
            );
            const greeting = yield* sandbox.files.readText("/home/user/greeting.txt");
            yield* sandbox.kill();
            // Reads and tags on the runtime-built template.
            const found = yield* templates.get(first.templateId);
            const listed = yield* templates.list();
            const defaults = yield* templates.listDefaults();
            const searched = yield* templates.search({ search: name });
            const status = yield* templates.buildStatus(first.templateId, first.buildId);
            const logs = yield* templates.buildLogs(first.templateId, first.buildId);
            yield* templates.setPublic(first.templateId, false);
            yield* templates.tags.assign(name, ["v1"]);
            const tagged = yield* templates.tags.exists(first.templateId, "v1");
            const tagCount = yield* templates.tags.count(first.templateId);
            const tagList = yield* templates.tags.list(first.templateId);
            const groups = yield* templates.tags.groups(first.templateId);
            const assignments = yield* templates.tags.assignments(first.templateId, "v1");
            yield* templates.tags.remove(name, ["v1"]);
            const untagged = yield* templates.tags.exists(first.templateId, "v1");
            yield* templates.delete(first.templateId);
            return {
              sameBuild: first.buildId === second.buildId,
              greeting,
              foundBuild: found?.buildID === first.buildId,
              listed: listed.some((t) => t.templateID === first.templateId),
              defaults: defaults.length,
              searched: searched.data.length,
              status: status.status,
              logs: logs.logs.length,
              tagged,
              tagCount,
              tags: tagList.map((t) => t.tag),
              groups: groups.tags.length,
              assignments: assignments.data.length,
              untagged,
            };
          }),
        // Leaves a sandbox and a secret behind, as a crashed request would; the
        // host's sweep removes them when the host is destroyed.
        // Objects created at run time, with user metadata that tries to
        // replace an `alchemy::*` key. The test checks their tags and
        // deletes them itself.
        "/tagged": (query) =>
          Effect.gen(function* () {
            const name = query.get("name") ?? "alchemy-binding-tagged";
            const metadata = { purpose: "tag-check", "alchemy::id": "spoofed" };
            const sandbox = yield* sandboxes.create({ timeout: 300, metadata });
            const secret = yield* secrets.put(name, Redacted.make("tagged"), { metadata });
            return { sandboxId: sandbox.sandboxId, secretId: secret.secretId };
          }),
        // ReadWebhook: delivery history and stats of a declared webhook.
        "/webhook": () =>
          Effect.gen(function* () {
            const deliveries = yield* probe.deliveries({});
            const stats = yield* probe.stats({});
            return { groups: deliveries.data.length, total: stats.total };
          }),
        // ReadTeam: the lifecycle event log.
        "/team": () =>
          Effect.gen(function* () {
            const events = yield* team.events({ limit: 5 });
            const sandboxId = events[0]?.sandboxId;
            const sandboxEvents =
              sandboxId === undefined ? [] : yield* team.sandboxEvents(sandboxId, { limit: 5 });
            const now = Math.floor(Date.now() / 1000);
            const metrics = yield* team.metrics({ start: now - 3600, end: now });
            const peak = yield* team.maxMetric({
              metric: "concurrent_sandboxes",
              start: now - 3600,
              end: now,
            });
            return {
              count: events.length,
              sandboxEvents: sandboxEvents.length,
              teamId: yield* team.teamId,
              metrics: metrics.length,
              peak: peak.value,
            };
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
