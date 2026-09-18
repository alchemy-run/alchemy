import {
  Container,
  type ContainerDeclaration,
} from "@/Celld/Containers/Container.ts";
import {
  fromNativeContainer,
  type ContainerClient,
  type NativeContainer,
  type NativeContainerExecProcess,
} from "@/Celld/Containers/Native.ts";
import { layer } from "@/Celld/Containers/StartContainer.ts";
import { DurableObjectScope } from "@/Celld/DurableObject.ts";
import { DurableObjectState } from "@/Celld/DurableObjectState.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { Self } from "@/Self.ts";
import {
  durableObjectPlanContext,
  type DurableObjectHostLike,
} from "@/Workers/DurableObject.ts";
import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { Tool } from "./fixtures/Tool.ts";
import ToolLive from "./fixtures/Tool.runtime.ts";
import { checkContainer, probeStartup } from "../fixtures/ecs-live/worker.ts";

class ImageTool extends Container<ImageTool>()("ImageTool", {
  image: "alpine:3.20",
  ociRuntime: "runsc",
  instanceType: "dev",
  maxInstances: 4,
}) {}

const nativeFixture = () =>
  Effect.sync(() => {
    const calls: string[] = [];
    let running = false;
    const process: NativeContainerExecProcess = {
      pid: 7,
      stdin: null,
      stdout: null,
      stderr: null,
      get exitCode() {
        calls.push("exitCode");
        return Effect.runPromise(Effect.succeed(3));
      },
      output: () =>
        Effect.runPromise(
          Effect.sync(() => {
            calls.push("output");
            return {
              stdout: new ArrayBuffer(2),
              stderr: new ArrayBuffer(1),
              exitCode: 3,
            };
          }),
        ),
      kill: () => {
        calls.push("kill");
      },
    };
    const native: NativeContainer = {
      get running() {
        calls.push("running");
        return running;
      },
      start: () => {
        calls.push("start");
        if (running) throw new Error("already running");
        running = true;
      },
      monitor: () => {
        calls.push("monitor");
        return Effect.runPromise(Effect.fail(new Error("native exit 7")));
      },
      destroy: () =>
        Effect.runPromise(
          Effect.sync(() => {
            calls.push("destroy");
            running = false;
          }),
        ),
      signal: (signal) => {
        calls.push(`signal:${signal}`);
        if (signal < 1) throw new Error("Invalid signal number");
      },
      setInactivityTimeout: (duration) =>
        Effect.runPromise(
          Effect.sync(() => {
            calls.push(`timeout:${duration}`);
            return "";
          }),
        ),
      getTcpPort: (port) => {
        calls.push(`port:${port}`);
        if (port < 1 || port > 65535) throw new Error("Invalid port number");
        return {
          connect: () => {
            calls.push("connect");
            return {
              readable: new ReadableStream<Uint8Array>(),
              writable: new WritableStream<Uint8Array>(),
              get opened() {
                return Effect.runPromise(Effect.succeed({}));
              },
              get closed() {
                return Effect.runPromise(Effect.void);
              },
              close: () =>
                Effect.runPromise(
                  Effect.sync(() => {
                    calls.push("socket.close");
                  }),
                ),
            };
          },
          fetch: () =>
            Effect.runPromise(
              Effect.sync(() => {
                calls.push("fetch");
                return new Response("native");
              }),
            ),
        };
      },
      exec: () =>
        Effect.runPromise(
          Effect.sync(() => {
            calls.push("exec");
            return process;
          }),
        ),
    };
    return { native, calls, process };
  });

const hostFixture = (
  declarations: ContainerDeclaration[],
): DurableObjectHostLike => ({
  Type: "Celld.Worker",
  LogicalId: "Worker",
  bind: () => (data: { containers: ContainerDeclaration[] }) =>
    Effect.sync(() => {
      declarations.push(...data.containers);
    }),
  export: () => Effect.void,
  durableObjectBinding: (declaration) => declaration,
  durableObjectStub: (stub) => stub,
});

const planServices = (declarations: ContainerDeclaration[]) =>
  Layer.mergeAll(
    Layer.succeed(Self, hostFixture(declarations)),
    Layer.succeed(DurableObjectScope, {
      kind: "Celld.DurableObject",
      Type: "Celld.DurableObject",
      name: "Agent",
      getByName: () => {
        throw new Error("Unexpected runtime call");
      },
    }),
    Layer.succeedContext(durableObjectPlanContext(DurableObjectState)),
  );

const withRuntimeContainer = <A, E, R>(
  native: NativeContainer,
  use: (client: ContainerClient) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const previous = globalThis.__ALCHEMY_RUNTIME__;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        globalThis.__ALCHEMY_RUNTIME__ = true;
      }),
      () =>
        Effect.sync(() => {
          globalThis.__ALCHEMY_RUNTIME__ = previous;
        }),
    );
    const state = new Proxy(
      Context.get(
        durableObjectPlanContext(DurableObjectState),
        DurableObjectState,
      ),
      {
        get: (target, key, receiver) =>
          key === "container" ? native : Reflect.get(target, key, receiver),
      },
    );
    return yield* Effect.flatMap(ImageTool, use).pipe(
      Effect.provide(
        layer(ImageTool, probeStartup).pipe(
          Layer.provide(
            Layer.mergeAll(
              planServices([]),
              Layer.succeed(DurableObjectState, state),
              RuntimeContext.phantom,
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(RuntimeContext.phantom));

describe("Celld Container declarations and runtime", () => {
  it.effect(
    "class-shaped image declarations emit DO-associated Worker metadata without a cloud id",
    () =>
      Effect.gen(function* () {
        const declarations: ContainerDeclaration[] = [];
        const client = yield* ImageTool.pipe(
          Effect.provide(
            layer(ImageTool).pipe(Layer.provide(planServices(declarations))),
          ),
        );
        expect(typeof client.start).toBe("function");
        expect(declarations).toEqual([
          {
            name: "ImageTool",
            className: "Agent",
            image: "alpine:3.20",
            ociRuntime: "runsc",
            instanceType: "dev",
            maxInstances: 4,
          },
        ]);
        expect("Application" in ImageTool).toBe(false);
      }),
  );

  it.effect(
    "make supplies generated source metadata without evaluating the process implementation",
    () =>
      Effect.gen(function* () {
        const declarations: ContainerDeclaration[] = [];
        yield* Tool.pipe(
          Effect.provide(
            layer(Tool).pipe(
              Layer.provide(
                Layer.mergeAll(ToolLive, planServices(declarations)),
              ),
            ),
          ),
        );
        expect(declarations[0]).toMatchObject({
          name: "Tool",
          className: "Agent",
          runtime: "bun",
          ociRuntime: "runsc",
          maxInstances: 4,
        });
        expect(declarations[0]).toHaveProperty("main");
      }),
  );

  it.effect(
    "adapters create no promises at init and preserve native errors and output bytes",
    () =>
      Effect.gen(function* () {
        const { native, calls } = yield* nativeFixture();
        const client = fromNativeContainer(() => native);
        expect(calls).toEqual([]);
        yield* client.start({ entrypoint: ["sleep", "infinity"] });
        expect(yield* client.running).toBe(true);
        const startedAgain = yield* Effect.result(client.start());
        expect(
          Result.isFailure(startedAgain) && startedAgain.failure._tag,
        ).toBe("Celld.ContainerError");
        const monitored = yield* Effect.result(client.monitor());
        expect(
          Result.isFailure(monitored) && monitored.failure.cause,
        ).toBeInstanceOf(Error);
        const process = yield* client.exec(["sh", "-c", "exit 3"]);
        expect(calls.includes("exitCode")).toBe(false);
        const output = yield* process.output();
        expect(output.stdout).toBeInstanceOf(ArrayBuffer);
        expect(output.exitCode).toBe(3);
        yield* client.signal(15);
        yield* client.setInactivityTimeout(1000);
        yield* client.destroy();
        expect(yield* client.running).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(RuntimeContext.phantom)),
  );

  it.effect(
    "TCP connections are acquired lazily and closed with the request",
    () =>
      Effect.gen(function* () {
        const { native, calls } = yield* nativeFixture();
        const port = yield* fromNativeContainer(() => native).getTcpPort(3000);
        expect(calls).toEqual(["port:3000"]);
        yield* port.connect("ignored:80").pipe(Effect.scoped);
        expect(calls).toEqual(["port:3000", "connect", "socket.close"]);
      }).pipe(Effect.provide(RuntimeContext.phantom)),
  );

  it.effect("request scopes terminate uncollected exec processes", () =>
    Effect.gen(function* () {
      const { native, calls } = yield* nativeFixture();
      yield* fromNativeContainer(() => native)
        .exec(["sleep", "infinity"])
        .pipe(Effect.scoped);
      expect(calls).toEqual(["exec", "kill"]);
    }).pipe(Effect.provide(RuntimeContext.phantom)),
  );

  it.effect(
    "ports validate on acquisition and perform fresh fetch I/O on every call",
    () =>
      Effect.gen(function* () {
        const { native, calls } = yield* nativeFixture();
        const client = fromNativeContainer(() => native);
        const invalid = yield* Effect.result(client.getTcpPort(0));
        expect(Result.isFailure(invalid)).toBe(true);
        const port = yield* client.getTcpPort(3000);
        expect(calls).toEqual(["port:0", "port:3000"]);
        expect(
          yield* (yield* port.fetch(HttpClientRequest.get("http://container/")))
            .text,
        ).toBe("native");
        yield* port.fetch(HttpClientRequest.get("http://container/"));
        expect(calls.filter((call) => call === "fetch")).toHaveLength(2);
      }).pipe(Effect.provide(RuntimeContext.phantom)),
  );

  it.live(
    "EC2 probe waits for HTTP readiness before one exec and preserves its report",
    () =>
      Effect.gen(function* () {
        const { native, calls, process } = yield* nativeFixture();
        native.monitor = () => Effect.runPromise(Effect.never);
        let ready = false;
        let attempts = 0;
        const getTcpPort = native.getTcpPort;
        native.getTcpPort = (port) => ({
          ...getTcpPort(port),
          fetch: () =>
            Effect.runPromise(
              Effect.gen(function* () {
                calls.push("readiness");
                if (++attempts < 3)
                  return yield* Effect.fail(new Error("starting"));
                ready = true;
                return yield* Effect.sync(() => new Response(null));
              }),
            ),
        });
        const exec = native.exec;
        native.exec = (...args) => {
          expect(ready).toBe(true);
          return exec(...args);
        };
        process.output = () =>
          Effect.runPromise(
            Effect.sync(() => {
              calls.push("output");
              return {
                stdout: new TextEncoder().encode(
                  "celld-runsc-ok\nFENCE_BLOCKED\n",
                ).buffer,
                stderr: new TextEncoder().encode("diagnostic").buffer,
                exitCode: 0,
              };
            }),
          );
        const report = yield* withRuntimeContainer(native, checkContainer);
        expect(report).toEqual({
          stdout: "celld-runsc-ok\nFENCE_BLOCKED\n",
          stderr: "diagnostic",
          exitCode: 0,
        });
        expect(attempts).toBe(3);
        expect(calls.filter((call) => call === "start")).toHaveLength(1);
        expect(calls.filter((call) => call === "exec")).toHaveLength(1);
        expect(calls.filter((call) => call === "output")).toHaveLength(1);
        expect(calls.filter((call) => call === "destroy")).toHaveLength(1);
        expect(calls.includes("kill")).toBe(false);
      }),
    { exclusive: true, timeout: 15_000 },
  );

  it.effect(
    "EC2 probe preserves exec and output failures without repeating execution",
    () =>
      Effect.gen(function* () {
        for (const operation of ["exec", "output"] as const) {
          const { native, calls, process } = yield* nativeFixture();
          native.monitor = () => Effect.runPromise(Effect.never);
          const failure = new Error(`${operation} failed`);
          const fail = () =>
            Effect.runPromise(
              Effect.sync(() => {
                calls.push(operation);
              }).pipe(Effect.andThen(Effect.fail(failure))),
            );
          if (operation === "exec") native.exec = fail;
          else process.output = fail;
          const result = yield* Effect.exit(
            withRuntimeContainer(native, checkContainer),
          );
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result)) {
            expect(Cause.squash(result.cause)).toMatchObject({
              _tag: "Celld.ContainerError",
              cause: failure,
            });
          }
          expect(calls.filter((call) => call === "exec")).toHaveLength(1);
          expect(calls.filter((call) => call === "output")).toHaveLength(
            operation === "exec" ? 0 : 1,
          );
          expect(calls.filter((call) => call === "destroy")).toHaveLength(1);
        }
      }),
    { exclusive: true },
  );

  it.effect(
    "EC2 probe surfaces startup failure before readiness without executing",
    () =>
      Effect.gen(function* () {
        const { native, calls } = yield* nativeFixture();
        const getTcpPort = native.getTcpPort;
        native.getTcpPort = (port) => ({
          ...getTcpPort(port),
          fetch: () => Effect.runPromise(Effect.never),
        });
        const result = yield* Effect.exit(
          withRuntimeContainer(native, checkContainer),
        );
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          expect(Cause.squash(result.cause)).toMatchObject({
            _tag: "Celld.ContainerError",
            message: "Celld container monitor failed",
          });
        }
        expect(calls.filter((call) => call === "exec")).toHaveLength(0);
        expect(calls.filter((call) => call === "destroy")).toHaveLength(1);
      }),
    { exclusive: true },
  );

  it.effect(
    "runtime layer starts lazily and coalesces concurrent starts",
    () =>
      Effect.gen(function* () {
        const { native, calls } = yield* nativeFixture();
        yield* withRuntimeContainer(native, (client) =>
          Effect.gen(function* () {
            expect(calls).toEqual([]);
            yield* Effect.all(
              [client.getTcpPort(3000), client.getTcpPort(3000)],
              { concurrency: "unbounded" },
            );
            expect(calls.filter((call) => call === "start")).toHaveLength(1);
            expect(calls.includes("monitor")).toBe(false);
          }),
        );
      }),
    { exclusive: true },
  );
});
