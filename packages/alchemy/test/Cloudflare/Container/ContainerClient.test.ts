import type * as cf from "@cloudflare/workers-types";
import { describe, expect, it } from "alchemy-test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import type {
  AnyContainerApplicationProps,
  DurableObjectContainerProps,
} from "@/Cloudflare/Containers/ContainerApplication.ts";
import { fromContainer } from "@/Cloudflare/Containers/ContainerClient.ts";
import { validateContainerConfiguration } from "@/Cloudflare/Containers/ContainerConfiguration.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";

const client = (native: Partial<cf.Container>) => fromContainer(() => native as cf.Container);
const bytes = (text: string) => new TextEncoder().encode(text).buffer;
const process = (overrides: Partial<cf.ExecProcess> = {}): cf.ExecProcess => ({
  pid: 42,
  isPty: false,
  stdin: null,
  stdout: null,
  stderr: null,
  exitCode: Promise.resolve(0),
  output: async () => ({ stdout: bytes("ok"), stderr: bytes(""), exitCode: 0 }),
  kill: () => {},
  resize: () => {},
  ...overrides,
});

describe(
  "native Container client",
  { tags: ["unit", "local", "provider:cloudflare:container"] },
  () => {
    it.effect("does not access or start a container during construction", () =>
      Effect.gen(function* () {
        let reads = 0;
        const sandbox = fromContainer(() => {
          reads++;
          return undefined;
        });
        expect(reads).toBe(0);
        const failure = yield* sandbox.running.pipe(Effect.flip);
        expect(reads).toBe(1);
        expect(failure._tag).toBe("ContainerError");
      }).pipe(Effect.provide(RuntimeContext.phantom)),
    );

    it.effect("passes native image, snapshot, and instance options through", () =>
      Effect.gen(function* () {
        const calls: Array<cf.ContainerStartupOptions | undefined> = [];
        const snapshot: cf.ContainerSnapshot = { id: "snapshot", size: 123 };
        const sandbox = client({
          images: { node: "digest" },
          start: (options) => {
            calls.push(options);
          },
          snapshotContainer: async () => snapshot,
        });
        expect(yield* sandbox.images).toEqual({ node: "digest" });
        yield* sandbox.start({
          image: "digest",
          instance: "standard-2",
          enableInternet: false,
        });
        const saved = yield* sandbox.snapshotContainer();
        yield* sandbox.start({
          containerSnapshot: saved,
          enableInternet: false,
        });
        expect(calls).toEqual([
          { image: "digest", instance: "standard-2", enableInternet: false },
          { containerSnapshot: snapshot, enableInternet: false },
        ]);
      }).pipe(Effect.provide(RuntimeContext.phantom)),
    );

    it.effect("collects nonzero process output without killing a completed process", () =>
      Effect.gen(function* () {
        const signals: number[] = [];
        const sandbox = client({
          exec: async (args) => {
            expect(args).toEqual(["sh", "-c", "exit 7"]);
            return process({
              output: async () => ({
                stdout: bytes(""),
                stderr: bytes("failed"),
                exitCode: 7,
              }),
              kill: (signal) => {
                signals.push(signal ?? 15);
              },
            });
          },
        });
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* sandbox.exec(["sh", "-c", "exit 7"]);
            return yield* child.output();
          }),
        );
        expect(new TextDecoder().decode(result.stderr)).toBe("failed");
        expect(result.exitCode).toBe(7);
        expect(signals).toEqual([]);
      }).pipe(Effect.provide(RuntimeContext.phantom)),
    );

    it.effect("kills an unfinished process when its request is interrupted", () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const signals: number[] = [];
        const sandbox = client({
          exec: async () =>
            process({
              kill: (signal) => {
                signals.push(signal ?? 15);
              },
            }),
        });
        const fiber = yield* Effect.gen(function* () {
          yield* sandbox.exec(["sleep", "infinity"]);
          yield* Deferred.succeed(started, undefined);
          yield* Effect.never;
        }).pipe(Effect.scoped, Effect.forkChild);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        expect(signals).toEqual([9]);
      }).pipe(Effect.provide(RuntimeContext.phantom)),
    );

    it.effect("aborts exec acquisition when its request is interrupted", () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<cf.AbortSignal>();
        const sandbox = client({
          exec: (_cmd, options) =>
            new Promise((_resolve, reject) => {
              const signal = options!.signal!;
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
              Deferred.doneUnsafe(started, Effect.succeed(signal));
            }),
        });
        const fiber = yield* sandbox
          .exec(["sleep", "infinity"])
          .pipe(Effect.scoped, Effect.forkChild);
        const signal = yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        expect(signal.aborted).toBe(true);
      }).pipe(Effect.provide(RuntimeContext.phantom)),
    );

    it.effect("streams stdout and maps process failures into ContainerError", () =>
      Effect.gen(function* () {
        const cause = new Error("container exited");
        const sandbox = client({
          exec: async () =>
            process({
              stdout: new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("hello"));
                  controller.close();
                },
              }) as unknown as cf.ReadableStream,
            }),
          monitor: async () => {
            throw cause;
          },
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* sandbox.exec(["printf", "hello"]);
            const output = yield* child.stdout!.pipe(Stream.decodeText(), Stream.mkString);
            expect(output).toBe("hello");
            yield* child.exitCode;
          }),
        );
        const failure = yield* sandbox.monitor().pipe(Effect.flip);
        expect(failure.cause).toBe(cause);
      }).pipe(Effect.provide(RuntimeContext.phantom)),
    );
  },
);

describe(
  "native Container configuration",
  { tags: ["unit", "local", "provider:cloudflare:container"] },
  () => {
    it.effect("rejects more than 100 named images before publishing", () =>
      Effect.gen(function* () {
        const images = Object.fromEntries(
          Array.from(
            { length: 101 },
            (_, index) => [`image-${index}`, { image: "alpine:3.21" }] as const,
          ),
        );
        const failure = yield* validateContainerConfiguration({
          schedulingPolicy: "durable_object",
          images,
        }).pipe(Effect.flip);
        expect(failure._tag).toBe("ContainerConfigurationError");
        expect(failure.message).toContain("100");
      }),
    );
    for (const name of ["", "a".repeat(129)]) {
      it.effect(`rejects an image name with ${name.length} characters`, () =>
        Effect.gen(function* () {
          const failure = yield* validateContainerConfiguration({
            schedulingPolicy: "durable_object",
            images: { [name]: { image: "alpine:3.21" } },
          }).pipe(Effect.flip);
          expect(failure._tag).toBe("ContainerConfigurationError");
          expect(failure.message).toContain("128");
        }),
      );
    }
    it.effect("accepts the named image count and name length limits", () =>
      validateContainerConfiguration({
        schedulingPolicy: "durable_object",
        images: Object.fromEntries([
          ["a".repeat(128), { image: "alpine:3.21" }] as const,
          ...Array.from(
            { length: 99 },
            (_, index) => [`image-${index}`, { image: "alpine:3.21" }] as const,
          ),
        ]),
      }),
    );
    for (const prop of [
      "image",
      "main",
      "instanceType",
      "maxInstances",
      "instances",
      "env",
      "rollout",
    ] as const) {
      it.effect(`rejects deployment property ${prop}`, () =>
        Effect.gen(function* () {
          const failure = yield* validateContainerConfiguration({
            schedulingPolicy: "durable_object",
            [prop]: "invalid",
          } as AnyContainerApplicationProps).pipe(Effect.flip);
          expect(failure.message).toContain(prop);
        }),
      );
    }
    it.effect("requires a new namespace when changing scheduling policy", () =>
      Effect.gen(function* () {
        const failure = yield* validateContainerConfiguration(
          { schedulingPolicy: "durable_object" },
          "default",
        ).pipe(Effect.flip);
        expect(failure.message).toContain("new container application and Durable Object class");
        yield* validateContainerConfiguration(
          { schedulingPolicy: "durable_object" },
          "durable_object",
        );
        yield* validateContainerConfiguration({ image: "alpine:3.21" }, "default");
      }),
    );
  },
);

const invalid: DurableObjectContainerProps = {
  schedulingPolicy: "durable_object",
  // @ts-expect-error Instance sizes are selected by start(), not at deployment.
  instanceType: "lite",
};
void invalid;
