import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Cloudflare from "@/Cloudflare";
import { DurableObjectState } from "@/Cloudflare/Workers/DurableObjectState.ts";
import { NativeImages } from "./images.ts";

export class NativeImage extends Cloudflare.Container<NativeImage>()(
  "NativeImage",
  Effect.map(NativeImages, (images) => ({
    schedulingPolicy: "durable_object",
    images,
  })),
) {}

const SLEEP_FOREVER = ["sleep", "infinity"];
const SEED_FILE = ["sh", "-c", "printf writable > /redeploy-marker"];
const READ_RELEASE_AND_SEED = [
  "sh",
  "-c",
  "cat /etc/alpine-release; cat /redeploy-marker 2>/dev/null || true",
];

const decode = (bytes: ArrayBuffer) => new TextDecoder().decode(bytes);

export class NativeObject extends Cloudflare.DurableObject<NativeObject>()(
  "NativeObject",
  Effect.gen(function* () {
    const container = yield* Cloudflare.Containers.bind(NativeImage);
    const state = yield* DurableObjectState;
    /** Changes whenever the runtime re-creates this object. */
    let incarnation: string | undefined;

    const storedMarker = Effect.map(
      state.storage.get<string>("marker"),
      (marker) => marker ?? null,
    );

    /** Run a command in the started container and collect its output. */
    const run = (cmd: string[]) =>
      Effect.scoped(Effect.flatMap(container.exec(cmd), (child) => child.output()));

    const startImage = Effect.fn(function* (name: string) {
      const images = yield* container.images;
      yield* container.start({
        image: images[name],
        entrypoint: SLEEP_FOREVER,
        enableInternet: false,
      });
    });

    /** Snapshot a file, prove a fresh start lacks it, then restore it. */
    const snapshotRoundTrip = Effect.gen(function* () {
      yield* run(["sh", "-c", "printf persisted > /workspace-file"]);
      const snapshot = yield* container.snapshotContainer();
      yield* container.destroy();

      yield* startImage("shell");
      const fresh = yield* run(["test", "!", "-e", "/workspace-file"]);
      if (fresh.exitCode !== 0) {
        return yield* Effect.die("Fresh container retained snapshot file");
      }
      yield* container.destroy();

      yield* container.start({
        containerSnapshot: snapshot,
        entrypoint: SLEEP_FOREVER,
        enableInternet: false,
      });
      return yield* run(["cat", "/workspace-file"]);
    });

    /** Pipe "native stdin" through `cat` while collecting its output. */
    const stdinRoundTrip = Effect.scoped(
      Effect.gen(function* () {
        const child = yield* container.exec(["cat"], { stdin: "pipe" });
        const writeStdin = Stream.make(new TextEncoder().encode("native stdin")).pipe(
          Stream.run(child.stdin!),
        );
        const [, output] = yield* Effect.all([writeStdin, child.output()], {
          concurrency: "unbounded",
        });
        return output;
      }),
    );

    return Effect.succeed({
      metadata: Effect.fn(function* () {
        incarnation ??= crypto.randomUUID();
        return {
          id: state.id.toString(),
          incarnation,
          images: yield* container.images,
          stored: yield* storedMarker,
        };
      }),
      evict: () => state.abort("container image eviction probe", { retryAlarm: false }),
      revision: () =>
        Effect.promise(async () => {
          const { env } = await import("cloudflare:workers");
          return (env as { IMAGE_REVISION: string }).IMAGE_REVISION;
        }),
      /** Report which image is running and whether the seeded file survived. */
      probe: Effect.fn(function* (options: { seed: boolean; restart: boolean; image: string }) {
        if (options.restart) yield* container.destroy();

        const wasRunning = yield* container.running;
        if (!wasRunning) yield* startImage(options.image);
        if (options.seed) {
          yield* state.storage.put("marker", "durable");
          yield* run(SEED_FILE);
        }

        const output = yield* run(READ_RELEASE_AND_SEED);
        const [release, file] = decode(output.stdout).split("\n");
        return {
          wasRunning,
          configured: (yield* container.images)[options.image],
          inspected: (yield* container.inspect())?.image,
          release,
          file,
          stored: yield* storedMarker,
        };
      }),
      // The application's RPC can still be named exec; native exec lives on
      // the separate client and does not overwrite the application's methods.
      exec: Effect.fn(function* (mode: "exec" | "stdin" | "snapshot" = "exec") {
        if (!(yield* container.running)) {
          const images = yield* container.images;
          yield* container.start({
            image: images.shell,
            entrypoint: SLEEP_FOREVER,
            enableInternet: false,
            instance: "lite",
          });
        }

        let output: Cloudflare.Containers.ContainerExecOutput;
        if (mode === "snapshot") {
          output = yield* snapshotRoundTrip;
        } else if (mode === "stdin") {
          output = yield* stdinRoundTrip;
        } else {
          output = yield* run(["sh", "-c", "printf native; exit 7"]);
        }

        return {
          stdout: decode(output.stdout),
          exitCode: output.exitCode,
          images: Object.keys(yield* container.images),
        };
      }),
    });
  }),
) {}
