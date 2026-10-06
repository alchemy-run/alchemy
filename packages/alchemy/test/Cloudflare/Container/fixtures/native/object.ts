import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Result from "effect/Result";
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

/** Only the owning object's `interceptOutboundHttp` answers this host. */
const INTERCEPT_HOST = "intercept.internal";

export class NativeObject extends Cloudflare.DurableObject<NativeObject>()(
  "NativeObject",
  Effect.gen(function* () {
    const container = yield* Cloudflare.Containers.bind(NativeImage);
    const state = yield* DurableObjectState;
    const env = yield* Cloudflare.WorkerEnvironment;
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

    const ensureShell = Effect.gen(function* () {
      if (!(yield* container.running)) yield* startImage("shell");
    });

    /** Process lifecycle against the real runtime (workerd + Docker or Cloudflare). */
    const lifecycle = Effect.fn(function* (mode: "interrupt" | "stream" | "monitor" | "intercept") {
      if (mode === "intercept") {
        // Started without internet: only this object's interception can answer.
        yield* ensureShell;
        const self = Cloudflare.fromCloudflareFetcher(env.NativeObject.get(state.id));
        yield* container.interceptOutboundHttp(INTERCEPT_HOST, self);
        const output = yield* run(["wget", "-qO-", `http://${INTERCEPT_HOST}/hello`]);
        return {
          exitCode: output.exitCode,
          stdout: decode(output.stdout),
          stderr: decode(output.stderr),
        };
      }
      if (mode === "interrupt") {
        yield* ensureShell;
        // Closing the exec scope (here via timeout) must SIGKILL the process.
        yield* Effect.scoped(
          Effect.flatMap(container.exec(["sleep", "301"]), (child) => child.exitCode),
        ).pipe(Effect.timeout("1 second"), Effect.ignore);
        // `30[1]` keeps pgrep from matching this shell's own command line.
        // Poll briefly: the kill is delivered asynchronously.
        const check = yield* run([
          "sh",
          "-c",
          "for i in 1 2 3 4 5 6; do pgrep -f 'sleep 30[1]' >/dev/null || exit 0; sleep 0.5; done; pgrep -f 'sleep 30[1]'",
        ]);
        return { remaining: decode(check.stdout).trim() };
      }
      if (mode === "stream") {
        yield* ensureShell;
        const chunks = yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* container.exec(["sh", "-c", "printf a; sleep 0.2; printf b"]);
            return yield* Stream.runCollect(child.stdout!);
          }),
        );
        return { stdout: chunks.map((chunk) => new TextDecoder().decode(chunk)).join("") };
      }
      if (yield* container.running) yield* container.destroy();
      const images = yield* container.images;
      yield* container.start({
        image: images.shell,
        entrypoint: ["sh", "-c", "exit 3"],
        enableInternet: false,
      });
      const result = yield* container.monitor().pipe(Effect.result);
      return Result.isFailure(result)
        ? { failed: true, tag: result.failure._tag }
        : { failed: false, tag: undefined };
    });

    return Effect.succeed({
      // Requests the container makes to INTERCEPT_HOST arrive here.
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        return HttpServerResponse.text(`intercepted ${request.headers.host}${request.url}`);
      }),
      lifecycle,
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
