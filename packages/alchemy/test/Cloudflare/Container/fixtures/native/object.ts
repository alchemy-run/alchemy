import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export class NativeImage extends Cloudflare.Container<NativeImage>()(
  "NativeImage",
  {
    schedulingPolicy: "durable_object",
    images: { shell: { image: "alpine:3.21" } },
  },
) {}

export class NativeObject extends Cloudflare.DurableObject<NativeObject>()(
  "NativeObject",
  Effect.gen(function* () {
    const container = yield* Cloudflare.Containers.bind(NativeImage);
    return Effect.succeed({
      // The application's RPC can still be named exec; native exec lives on
      // the separate client and does not overwrite the application's methods.
      exec: Effect.fn(function* (mode: "exec" | "stdin" | "snapshot" = "exec") {
        if (!(yield* container.running)) {
          const images = yield* container.images;
          yield* container.start({
            image: images.shell,
            entrypoint: ["sleep", "infinity"],
            enableInternet: false,
            instance: "lite",
          });
        }
        if (mode === "snapshot") {
          const write = yield* container.exec([
            "sh",
            "-c",
            "printf persisted > /workspace-file",
          ]);
          yield* write.output();
          const saved = yield* container.snapshotContainer();
          yield* container.destroy();
          yield* container.start({
            containerSnapshot: saved,
            entrypoint: ["sleep", "infinity"],
            enableInternet: false,
          });
        }
        const child = yield* container.exec(
          mode === "snapshot"
            ? ["cat", "/workspace-file"]
            : mode === "stdin"
              ? ["cat"]
              : ["sh", "-c", "printf native; exit 7"],
          mode === "stdin" ? { stdin: "pipe" } : undefined,
        );
        const output = yield* mode === "stdin"
          ? Effect.all(
              [
                Stream.make(new TextEncoder().encode("native stdin")).pipe(
                  Stream.run(child.stdin!),
                ),
                child.output(),
              ],
              { concurrency: "unbounded" },
            ).pipe(Effect.map(([, output]) => output))
          : child.output();
        return {
          stdout: new TextDecoder().decode(output.stdout),
          exitCode: output.exitCode,
          images: Object.keys(yield* container.images),
        };
      }),
    });
  }),
) {}
