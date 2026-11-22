import * as Archil from "@alchemy.run/archil";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { MountObject } from "./mount-object.ts";
import { Agent, Dataset, Preview, Seed, SEED_CHECKPOINT } from "./resources.ts";

const ArchilBindings = Layer.mergeAll(
  Archil.ExecDiskHttp,
  Archil.ExecDisksHttp,
  Archil.ReadDiskHttp,
  Archil.WriteDiskHttp,
  Archil.ReadWriteDiskHttp,
  Archil.BranchDiskHttp,
  Archil.CreateDiskHttp,
  Archil.CreateImageHttp,
  Archil.CreateSandboxHttp,
  Archil.ConnectSandboxHttp,
);

/**
 * An HTTP server for the getTcpPort tests: it answers 201 with an `x-echo`
 * header and a JSON body naming the method, path and query, the `x-test`
 * header and the body it received.
 */
const ECHO_PORT = 8082;
const ECHO_SERVER = `require("http").createServer((q, s) => {
  let body = "";
  q.on("data", (c) => (body += c));
  q.on("end", () => {
    s.writeHead(201, { "content-type": "application/json", "x-echo": "archil" });
    s.end(JSON.stringify({ method: q.method, url: q.url, header: q.headers["x-test"] ?? null, body }));
  });
}).listen(${ECHO_PORT}, "0.0.0.0");`;

const reportFailure = Effect.catchCause((cause: Cause.Cause<unknown>) =>
  Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
);

export default class ArchilWorker extends Cloudflare.Worker<ArchilWorker>()(
  "ArchilWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const exec = yield* Archil.ExecDisk(Dataset);
    const execMany = yield* Archil.ExecDisks();
    const read = yield* Archil.ReadDisk(Dataset);
    const write = yield* Archil.WriteDisk(Dataset);
    const files = yield* Archil.ReadWriteDisk(Dataset);
    const seeds = yield* Archil.BranchDisk(Seed);
    const disks = yield* Archil.CreateDisk();
    const images = yield* Archil.CreateImage();
    const sandboxes = yield* Archil.CreateSandbox(Agent);
    const preview = yield* Archil.ConnectSandbox(Preview);
    const mounts = yield* MountObject;

    // Start the echo server once (a second start just fails to bind), serve
    // its port publicly, and return it.
    const echoPort = Effect.gen(function* () {
      const probe = `wget -q -O- http://127.0.0.1:${ECHO_PORT}/ >/dev/null 2>&1`;
      const up = yield* preview.exec(`${probe} && echo up || echo down`);
      if (up.stdout.trim() !== "up") {
        yield* preview.files.write("/tmp/echo.js", ECHO_SERVER);
        yield* Effect.scoped(preview.start("node /tmp/echo.js"));
        yield* preview.exec(`for i in $(seq 1 50); do ${probe} && exit 0; sleep 0.2; done; exit 1`);
      }
      yield* preview.exposePort(ECHO_PORT);
      return yield* preview.getTcpPort(ECHO_PORT);
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const q = (name: string) => url.searchParams.get(name) ?? "";

        // Everything under /port-proxy/ goes to the echo server as it came.
        if (url.pathname.startsWith("/port-proxy/")) {
          const port = yield* echoPort;
          return yield* port.fetch(request);
        }

        switch (url.pathname) {
          case "/exec": {
            const result = yield* exec.exec(q("command"));
            return yield* HttpServerResponse.json(result);
          }
          case "/grep":
            return yield* HttpServerResponse.json(
              yield* exec.grep({ pattern: q("pattern"), directory: "/", recursive: true }),
            );
          case "/exec-many": {
            const source = yield* disks.create(`${q("user")}-src`);
            const home = yield* disks.create(q("user"));
            yield* source.put("hello.txt", "copied");
            const result = yield* execMany.exec({
              disks: { src: { disk: source.diskId, readOnly: true }, home: home.diskId },
              command:
                "cp /mnt/archil/src/hello.txt /mnt/archil/home/ && cat /mnt/archil/home/hello.txt",
            });
            // Destroying the stack leaves run-time disks in place.
            yield* disks.delete(`${q("user")}-src`);
            yield* disks.delete(q("user"));
            return yield* HttpServerResponse.json(result);
          }
          case "/put":
            yield* write.put(q("key"), yield* request.text);
            return yield* HttpServerResponse.json({ ok: true });
          case "/get":
            return HttpServerResponse.text(yield* read.getText(q("key")));
          case "/list":
            return yield* HttpServerResponse.json(
              yield* read.list("", { recursive: true }).pipe(
                Stream.map((o) => o.key),
                Stream.runCollect,
              ),
            );
          case "/upload": {
            // Three 4 MiB chunks: one full 8 MiB part plus a 4 MiB tail.
            const chunk = new Uint8Array(4 * 1024 * 1024).fill(97);
            const { etag } = yield* write.upload(q("key"), Stream.make(chunk, chunk, chunk));
            const head = yield* read.head(q("key"));
            const streamed = yield* read.getStream(q("key")).pipe(
              Stream.runFold(
                () => 0,
                (n, bytes) => n + bytes.byteLength,
              ),
            );
            return yield* HttpServerResponse.json({ etag, size: head?.size ?? null, streamed });
          }
          case "/delegations": {
            // A sandbox that mounts a disk and writes holds a write delegation.
            const disk = yield* disks.create(q("name"));
            const holder = yield* sandboxes.create({
              name: q("name"),
              mounts: [{ disk, path: "/mnt/archil" }],
            });
            yield* holder.exec("echo held > /mnt/archil/held.txt && sync");
            const held = yield* disk.delegations();
            yield* Effect.forEach(held, (d) => disk.revokeDelegation(d), { discard: true });
            const after = yield* disk.delegations();
            yield* holder.delete();
            yield* disks.delete(q("name"));
            // ExecDisk exposes the same call for deploy-time disks.
            const dataset = yield* exec.delegations();
            return yield* HttpServerResponse.json({
              held: held.length,
              after: after.length,
              dataset: Array.isArray(dataset),
            });
          }
          case "/share":
            return yield* HttpServerResponse.json({
              url: Redacted.value(yield* read.share(q("key"), 600)),
            });
          case "/roundtrip": {
            yield* files.append(q("key"), "a");
            yield* files.append(q("key"), "b");
            const text = yield* files.getText(q("key"));
            yield* files.delete(q("key"));
            return yield* HttpServerResponse.json({
              text,
              after: (yield* files.head(q("key"))) ?? null,
            });
          }
          case "/branch": {
            const branch = yield* seeds.branch({
              name: q("name"),
              fromCheckpoint: SEED_CHECKPOINT,
            });
            const all = (yield* seeds.listBranches()).map((b) => b.name);
            return yield* HttpServerResponse.json({ branch, all });
          }
          // The concurrent-create tests call these from many requests at once.
          case "/create-disk": {
            const disk = yield* disks.create(q("name"));
            return yield* HttpServerResponse.json({ id: disk.diskId });
          }
          case "/delete-disk":
            yield* disks.delete(q("name"));
            return HttpServerResponse.text("ok");
          case "/create-sandbox": {
            const sandbox = yield* sandboxes.create({ name: q("name") });
            return yield* HttpServerResponse.json({ id: sandbox.sandboxId });
          }
          case "/delete-sandbox":
            yield* sandboxes.delete(q("name"));
            return HttpServerResponse.text("ok");
          // A paused sandbox refuses process connections; exec resumes it.
          case "/paused": {
            const sandbox = yield* sandboxes.create({ name: q("name") });
            const paused = yield* sandbox.pause().pipe(
              Effect.repeat({
                schedule: Schedule.spaced("1 second"),
                until: (attrs) => attrs.status === "paused",
                times: 60,
              }),
            );
            const out = yield* sandbox.exec("echo -n awake");
            yield* sandboxes.delete(q("name"));
            return yield* HttpServerResponse.json({ paused: paused.status, stdout: out.stdout });
          }
          case "/disk": {
            const disk = yield* disks.create(q("name"));
            yield* disk.put("whoami.txt", q("name"));
            const result = yield* disk.exec("cat /mnt/archil/whoami.txt");
            const listed = (yield* disks.list()).map((d) => d.name);
            if (q("delete") === "1") yield* disks.delete(q("name"));
            const gone = (yield* disks.get(q("name"))) === undefined;
            return yield* HttpServerResponse.json({
              stdout: result.stdout,
              listed,
              name: disk.name,
              gone,
            });
          }
          case "/tagged": {
            // The test checks these out of band and deletes them itself.
            const disk = yield* disks.create(q("name"));
            const sandbox = yield* sandboxes.create({ name: q("name") });
            return yield* HttpServerResponse.json({
              disk: { id: disk.diskId, name: disk.name, prefix: disks.prefix },
              sandbox: { id: sandbox.sandboxId, name: sandbox.name, prefix: sandboxes.prefix },
            });
          }
          case "/image": {
            const image = yield* images.build({ image: "alpine:3.20" });
            return yield* HttpServerResponse.json(image);
          }
          case "/sandbox": {
            const sandbox = yield* sandboxes.create({ name: q("name") });
            // Deleted however the route ends, so a failure never strands it.
            return yield* Effect.gen(function* () {
              yield* sandbox.files.write("/tmp/note.txt", "hi from worker");
              const out = yield* sandbox.exec("cat /tmp/note.txt");
              const text = yield* sandbox.files.readText("/tmp/note.txt");
              // The rest of `files`: a directory, its listing, a stat, a removal.
              yield* sandbox.files.makeDir("/tmp/tree/sub");
              yield* sandbox.files.write("/tmp/tree/a.txt", "abc");
              const listed = (yield* sandbox.files.list("/tmp/tree"))
                .map((e) => `${e.type}:${e.path}`)
                .sort();
              const stat = yield* sandbox.files.stat("/tmp/tree/a.txt");
              yield* sandbox.files.remove("/tmp/tree");
              const removed = yield* sandbox.exec("test -e /tmp/tree");
              // An argument list is quoted; stdin is written, then closed.
              const piped = yield* sandbox.exec(["sh", "-c", "tr a-z A-Z"], { stdin: "piped in" });
              const failed = yield* sandbox.exec("exit 3");
              // A background process, attached until it exits.
              const started = yield* Effect.scoped(
                Effect.gen(function* () {
                  const process = yield* sandbox.start("echo -n started", { cwd: "/tmp" });
                  const output = yield* process.output.pipe(
                    Stream.map((chunk) => new TextDecoder().decode(chunk.data)),
                    Stream.mkString,
                  );
                  const exit = yield* process.wait;
                  return { output, exitCode: exit.exitCode };
                }),
              );
              // A terminal of 100 x 30.
              const size = yield* Effect.scoped(
                Effect.gen(function* () {
                  const pty = yield* sandbox.pty.open({
                    cols: 100,
                    rows: 30,
                    command: "stty size",
                  });
                  const output = yield* pty.output.pipe(
                    Stream.map((bytes) => new TextDecoder().decode(bytes)),
                    Stream.mkString,
                  );
                  yield* pty.wait;
                  return output.trim();
                }),
              );
              const forked = yield* sandbox.fork({ name: `${q("name")}-fork` });
              const forkOut = yield* forked
                .exec("cat /tmp/note.txt")
                .pipe(Effect.ensuring(forked.delete().pipe(Effect.ignore)));
              return yield* HttpServerResponse.json({
                stdout: out.stdout,
                text,
                listed,
                stat: { type: stat.type, size: stat.size },
                removed: removed.exitCode,
                piped: piped.stdout,
                failed: failed.exitCode,
                started,
                size,
                fork: forkOut.stdout,
              });
            }).pipe(Effect.ensuring(sandbox.delete().pipe(Effect.ignore)));
          }
          case "/preview": {
            const out = yield* preview.exec("echo -n preview-ok");
            const port = yield* preview.exposePort(8080);
            yield* preview.unexposePort(8080);
            return yield* HttpServerResponse.json({ stdout: out.stdout, hostname: port.hostname });
          }
          case "/port-client": {
            const port = yield* echoPort;
            const res = yield* port.fetch(
              HttpClientRequest.post("/echo/client?x=1&y=two").pipe(
                HttpClientRequest.setHeader("x-test", "client-header"),
                HttpClientRequest.bodyText("client-body"),
              ),
            );
            return yield* HttpServerResponse.json({
              status: res.status,
              echoHeader: res.headers["x-echo"] ?? null,
              contentType: res.headers["content-type"] ?? null,
              body: yield* res.json,
              port: { port: port.port, hostname: port.hostname, url: port.url },
            });
          }
          case "/port-tokens": {
            yield* preview.exposePort(8081);
            const token = yield* preview.createPortToken(8081, "1h");
            const listed = yield* preview.listPortTokens().pipe(
              Stream.map((t) => t.id),
              Stream.runCollect,
            );
            yield* preview.revokePortToken(token.tokenId);
            const after = yield* preview.listPortTokens().pipe(
              Stream.map((t) => t.id),
              Stream.runCollect,
            );
            yield* preview.unexposePort(8081);
            return yield* HttpServerResponse.json({ id: token.tokenId, listed, after });
          }
          case "/mount": {
            const result = yield* mounts.getByName("default").read(q("key"));
            return HttpServerResponse.text(result.body, { status: result.status });
          }
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }).pipe(reportFailure),
    };
  }).pipe(Effect.provide(ArchilBindings)),
) {}
