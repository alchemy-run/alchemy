import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { BindingAgent, SharedVolume } from "./resources.ts";

const BindingsLive = Layer.mergeAll(
  E2B.CreateSandboxHttp,
  E2B.CreateVolumeHttp,
  E2B.ReadVolumeHttp,
  E2B.WriteVolumeHttp,
  E2B.ReadWriteVolumeHttp,
  E2B.MountVolumeLive,
);

/** The volume bindings, apart from the other fixtures: volumes are enabled per team. */
export default class E2BVolumeWorker extends Cloudflare.Worker<E2BVolumeWorker>()(
  "E2BVolumeWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const sandboxes = yield* E2B.CreateSandbox(BindingAgent);
    const volumes = yield* E2B.CreateVolume();
    const readShared = yield* E2B.ReadVolume(SharedVolume);
    const writeShared = yield* E2B.WriteVolume(SharedVolume);
    const shared = yield* E2B.ReadWriteVolume(SharedVolume);
    const sharedMount = yield* E2B.MountVolume(SharedVolume, { path: "/home/user/shared" });

    const routes: Record<string, (query: URLSearchParams) => Effect.Effect<unknown, unknown, any>> =
      {
        // Read/Write/ReadWriteVolume on a declared volume.
        "/volume": () =>
          Effect.gen(function* () {
            yield* writeShared.makeDir("/data");
            yield* writeShared.write("/data/a.txt", "written");
            const read = yield* readShared.readText("/data/a.txt");
            const listed = yield* readShared.list("/data");
            const stat = yield* shared.stat("/data/a.txt");
            yield* shared.remove("/data/a.txt");
            const exists = yield* shared.exists("/data/a.txt");
            return { read, listed: listed.map((e) => e.name), size: stat.size, exists };
          }),
        // CreateVolume: a runtime volume, mounted into a sandbox.
        "/volumes": (query) =>
          Effect.gen(function* () {
            const name = query.get("name") ?? "alchemy-binding-volume";
            const volume = yield* volumes.getOrCreate(name);
            const again = yield* volumes.getOrCreate(name);
            yield* volume.files.write("/hello.txt", "from the volume api");
            const sandbox = yield* Effect.acquireRelease(
              sandboxes.create({
                timeout: 300,
                mounts: [{ volume, path: "/home/user/vol" }],
              }),
              (sandbox) => Effect.ignore(sandbox.kill()),
            );
            const seen = yield* sandbox.files.readText("/home/user/vol/hello.txt");
            yield* sandbox.files.write("/home/user/vol/back.txt", "from the sandbox");
            const back = yield* volume.files.readText("/back.txt");
            yield* sandbox.kill();
            yield* volumes.delete(volume.volumeId);
            const gone = yield* volumes.get(name);
            return {
              same: again.volumeId === volume.volumeId,
              seen,
              back,
              gone: gone === undefined,
            };
          }),
        // MountVolume from a Worker: the bound reference goes straight into `mounts`.
        "/mount": () =>
          Effect.gen(function* () {
            yield* writeShared.write("/mounted.txt", "seen through the mount");
            const sandbox = yield* Effect.acquireRelease(
              sandboxes.create({ timeout: 300, mounts: [sharedMount] }),
              (sandbox) => Effect.ignore(sandbox.kill()),
            );
            const seen = yield* sandbox.files.readText(`${sharedMount.path}/mounted.txt`);
            return { path: sharedMount.path, seen };
          }),
      };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
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
