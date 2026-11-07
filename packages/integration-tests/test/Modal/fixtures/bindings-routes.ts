import * as Modal from "@alchemy.run/modal";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Agents, Base, Coder, Jobs, Results, Token, Workspace } from "./resources.ts";

const BindingsLive = Layer.mergeAll(
  Modal.ReadWriteVolumeHttp,
  Modal.ReadVolumeHttp,
  Modal.WriteVolumeHttp,
  Modal.ReadWriteDictHttp,
  Modal.ReadDictHttp,
  Modal.WriteDictHttp,
  Modal.ReadWriteQueueHttp,
  Modal.ReadQueueHttp,
  Modal.WriteQueueHttp,
  Modal.WriteSecretHttp,
  Modal.CreateSandboxHttp,
  Modal.CreateImageHttp,
  Modal.CreateVolumeHttp,
  Modal.CreateDictHttp,
  Modal.CreateQueueHttp,
  Modal.CreateSecretHttp,
  Modal.MountVolumeLive,
);

/**
 * One route per Modal binding behavior, shared by every host the Bindings
 * suite deploys (a Lambda function and a Cloudflare Worker).
 */
export const bindingRoutes = Effect.gen(function* () {
  const volume = yield* Modal.ReadWriteVolume(Workspace);
  const readVolume = yield* Modal.ReadVolume(Workspace);
  const writeVolume = yield* Modal.WriteVolume(Workspace);
  const dict = yield* Modal.ReadWriteDict(Results);
  const readDict = yield* Modal.ReadDict(Results);
  const writeDict = yield* Modal.WriteDict(Results);
  const queue = yield* Modal.ReadWriteQueue(Jobs);
  const readQueue = yield* Modal.ReadQueue(Jobs);
  const writeQueue = yield* Modal.WriteQueue(Jobs);
  const secret = yield* Modal.WriteSecret(Token);
  const sandboxes = yield* Modal.CreateSandbox(Base);
  const appSandboxes = yield* Modal.CreateSandbox(Coder);
  const images = yield* Modal.CreateImage(Coder);
  const volumes = yield* Modal.CreateVolume(Agents);
  const dicts = yield* Modal.CreateDict(Agents);
  const queues = yield* Modal.CreateQueue(Agents);
  const secrets = yield* Modal.CreateSecret(Agents);
  const mountedWorkspace = yield* Modal.MountVolume(Workspace, {
    path: "/workspace",
    readOnly: true,
  });

  return {
    fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const url = new URL(request.url, "http://host");
      const key = url.searchParams.get("key") ?? "k";
      switch (url.pathname) {
        case "/volume": {
          yield* writeVolume.writeFile(`/${key}.txt`, `hello ${key}`);
          const text = yield* readVolume.readFileString(`/${key}.txt`);
          yield* volume.copyFiles([`/${key}.txt`], `/${key}-copy.txt`);
          const files = yield* volume.listFiles("/");
          yield* volume.removeFile(`/${key}-copy.txt`);
          return yield* HttpServerResponse.json({ text, files: files.map((f) => f.path) });
        }
        case "/dict": {
          yield* writeDict.put(key, { n: 1 });
          const value = yield* readDict.get(key);
          const contains = yield* readDict.contains(key);
          const popped = yield* dict.pop(key);
          const after = yield* dict.contains(key);
          return yield* HttpServerResponse.json({ value, contains, popped, after });
        }
        case "/queue": {
          yield* writeQueue.putMany([{ i: 1 }, { i: 2 }], { partition: key });
          const len = yield* readQueue.len({ partition: key });
          const taken = yield* queue.take({ partition: key, count: 2, timeout: 5 });
          return yield* HttpServerResponse.json({ len, taken });
        }
        case "/secret": {
          yield* secret.put({ TOKEN: `rotated-${key}` });
          return yield* HttpServerResponse.json({ ok: true });
        }
        case "/sandbox": {
          const sandbox = yield* sandboxes.create({ timeout: "5 minutes", tags: { test: key } });
          const result = yield* sandbox
            .exec(["cat", "/ready.txt"])
            .pipe(Effect.ensuring(Effect.ignore(sandbox.terminate())));
          return yield* HttpServerResponse.json(result);
        }
        case "/sandbox-logs": {
          const sandbox = yield* sandboxes.create({
            command: ["sh", "-c", "echo from-the-program"],
            timeout: "5 minutes",
            tags: { test: key },
          });
          const exit = yield* sandbox.wait("50 seconds");
          const logs = yield* sandbox.logs();
          return yield* HttpServerResponse.json({ exitCode: exit.exitCode, logs });
        }
        case "/sandbox-files": {
          const sandbox = yield* appSandboxes.create({
            image: "debian:bookworm-slim",
            timeout: "5 minutes",
          });
          const out = yield* Effect.gen(function* () {
            yield* sandbox.files.write("/tmp/x.txt", "written");
            const read = yield* sandbox.files.readText("/tmp/x.txt");
            const snapshot = yield* sandbox.snapshotFilesystem();
            return { read, snapshot: snapshot.imageId };
          }).pipe(Effect.ensuring(Effect.ignore(sandbox.terminate())));
          return yield* HttpServerResponse.json(out);
        }
        case "/mount": {
          // A runtime volume handle and a `MountVolume` reference, mounted
          // into a sandbox created per request.
          const home = yield* volumes.getOrCreate(`mount-${key}`);
          yield* home.writeFile("/hello.txt", `hello ${key}`);
          const sandbox = yield* appSandboxes.create({
            image: "debian:bookworm-slim",
            timeout: "5 minutes",
            mounts: [{ volume: home, path: "/home/user" }, mountedWorkspace],
          });
          const out = yield* Effect.gen(function* () {
            const run = yield* sandbox.exec(
              "cat /home/user/hello.txt && test -d /workspace && echo mounted",
            );
            const stat = yield* sandbox.files.stat("/home/user/hello.txt");
            return { stdout: run.stdout, exitCode: run.exitCode, size: stat.size, type: stat.type };
          }).pipe(Effect.ensuring(Effect.ignore(sandbox.terminate())));
          yield* volumes.delete(`mount-${key}`);
          return yield* HttpServerResponse.json(out);
        }
        case "/process": {
          // A started process streams as it runs; stdin is written mid-run.
          const sandbox = yield* appSandboxes.create({
            image: "debian:bookworm-slim",
            timeout: "5 minutes",
          });
          const out = yield* Effect.gen(function* () {
            const process = yield* sandbox.start(
              "echo one; sleep 2; echo two >&2; read line; echo got=$line",
            );
            const decoder = new TextDecoder();
            const chunks: Array<{ fd: string; text: string; at: number }> = [];
            const started = Date.now();
            const collect = Stream.runForEach(process.output, (chunk) =>
              Effect.sync(() =>
                chunks.push({
                  fd: chunk.fd,
                  text: decoder.decode(chunk.data),
                  at: Date.now() - started,
                }),
              ),
            );
            const collecting = yield* Effect.forkChild(collect);
            yield* Effect.sleep("4 seconds");
            yield* process.write("hello\n");
            const { exitCode } = yield* process.wait;
            yield* Fiber.join(collecting);
            const pty = yield* sandbox.pty.open({ cols: 80, rows: 24 });
            yield* pty.write("echo pty-$((40+2))\nexit\n");
            const screen = yield* Stream.runFold(
              pty.output,
              () => "",
              (text, data) => text + decoder.decode(data),
            ).pipe(Effect.timeout("30 seconds"));
            return { exitCode, chunks, pty: screen.includes("pty-42") };
          }).pipe(Effect.scoped, Effect.ensuring(Effect.ignore(sandbox.terminate())));
          return yield* HttpServerResponse.json(out);
        }
        case "/sandbox-named": {
          const name = `named-${key}`;
          const created = yield* appSandboxes.create({
            image: "debian:bookworm-slim",
            name,
            timeout: "5 minutes",
          });
          const found = yield* appSandboxes.fromName(name);
          yield* created.terminate();
          return yield* HttpServerResponse.json({
            created: created.sandboxId,
            found: found?.sandboxId,
          });
        }
        case "/sandbox-persistent": {
          const box = yield* appSandboxes.createPersistent({ image: "debian:bookworm-slim" });
          const out = yield* Effect.gen(function* () {
            const session = yield* box.session();
            yield* session.files.write("/root/notes.txt", `kept ${key}`);
            // A second handle by id reaches the same running session.
            const again = yield* (yield* appSandboxes.persistent(box)).session();
            return { read: yield* again.files.readText("/root/notes.txt") };
          }).pipe(Effect.ensuring(Effect.ignore(box.terminate())));
          return yield* HttpServerResponse.json(out);
        }
        case "/sandbox-usage": {
          const groups = yield* appSandboxes.usage({
            since: Date.now() - 86_400_000,
            groupByTags: ["test"],
          });
          return yield* HttpServerResponse.json({ groups: groups.length });
        }
        case "/image": {
          const image = yield* images.build({
            image: "debian:bookworm-slim",
            commands: ["COPY hello.txt /hello.txt"],
            files: { "hello.txt": `hello ${key}` },
          });
          const tag = `bindings-${key}`;
          yield* images.publish(image, tag);
          const published = yield* images.fromTag(tag);
          yield* images.unpublish(tag);
          const unpublished = yield* images.fromTag(tag);
          return yield* HttpServerResponse.json({
            imageId: image.imageId,
            published: published?.imageId,
            unpublished: unpublished?.imageId ?? null,
          });
        }
        case "/open": {
          const v = yield* volumes.getOrCreate(`open-${key}`);
          yield* v.writeFile("/a.txt", "a");
          const d = yield* dicts.getOrCreate(`open-${key}`);
          yield* d.put("a", 1);
          const q = yield* queues.getOrCreate(`open-${key}`);
          yield* q.put("a");
          const s = yield* secrets.put(`open-${key}`, { A: "1" });
          const listed = {
            volumes: (yield* volumes.list()).includes(`open-${key}`),
            dicts: (yield* dicts.list()).includes(`open-${key}`),
            queues: (yield* queues.list()).includes(`open-${key}`),
            secrets: (yield* secrets.list()).includes(`open-${key}`),
          };
          yield* volumes.delete(`open-${key}`);
          yield* dicts.delete(`open-${key}`);
          yield* queues.delete(`open-${key}`);
          yield* secrets.delete(`open-${key}`);
          const gone = (yield* volumes.get(`open-${key}`)) === undefined;
          return yield* HttpServerResponse.json({ listed, keys: s.keys, gone });
        }
        default:
          return HttpServerResponse.text("ok");
      }
    }).pipe(
      // Report the failure in the response so a failing case shows why.
      Effect.catchCause((cause) =>
        Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
      ),
    ),
  };
}).pipe(Effect.provide(BindingsLive));
