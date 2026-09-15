import { AsyncLocalStorage } from "node:async_hooks";
import { layer } from "@/Cloudflare/Workers/CloudflareTracer.ts";
import {
  Telemetry,
  type CloudflareTelemetryProps,
} from "@/Cloudflare/Workers/Telemetry.ts";
import { Worker } from "@/Cloudflare/Workers/Worker.ts";
import cloudflare_workers from "@/Cloudflare/Workers/cloudflare_workers.ts";
import { Self } from "@/Self.ts";
import * as Context from "effect/Context";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";

// Use the same fallback module as plan-time code, without replacing any
// production tracer logic. Each test holds the process-global write lock
// and restores the module and runtime flag before releasing it.
class FakeSpan {
  readonly isTraced = true;
  readonly attributes: Record<string, boolean | number | string | undefined> =
    {};
  ended = false;

  constructor(
    readonly name: string,
    readonly parent: FakeSpan | undefined,
    readonly store: string | undefined,
  ) {}

  setAttribute(key: string, value: boolean | number | string) {
    this.attributes[key] = value;
    return this;
  }

  setAttributes(
    attributes: Record<string, boolean | number | string | undefined>,
  ) {
    Object.assign(this.attributes, attributes);
    return this;
  }

  end() {
    this.ended = true;
  }
}

const withTracing = async (
  run: (fake: ReturnType<typeof makeTracing>) => Promise<void>,
) => {
  const workers = await Effect.runPromise(cloudflare_workers);
  const descriptor = Object.getOwnPropertyDescriptor(workers, "tracing");
  const fake = makeTracing();
  Object.defineProperty(workers, "tracing", {
    configurable: true,
    value: fake.tracing,
  });
  try {
    await run(fake);
  } finally {
    if (descriptor) Object.defineProperty(workers, "tracing", descriptor);
    else Reflect.deleteProperty(workers, "tracing");
  }
};

const makeTracing = () => {
  const active = new AsyncLocalStorage<FakeSpan>();
  const store = new AsyncLocalStorage<string>();
  const spans: FakeSpan[] = [];
  const tracing = {
    startActiveSpan<T>(name: string, callback: (span: FakeSpan) => T): T {
      const span = new FakeSpan(name, active.getStore(), store.getStore());
      spans.push(span);
      return active.run(span, () => callback(span));
    },
  };
  return { active, store, spans, tracing };
};

const buildTracer = (fiberContext: boolean) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(layer(fiberContext));
        return yield* Tracer.Tracer.pipe(Effect.provideContext(context));
      }),
    ),
  );

const readAfterCallback = (store: AsyncLocalStorage<string>) =>
  Effect.callback<string | undefined>((resume) => {
    store.run("request", () => {
      queueMicrotask(() => resume(Effect.sync(() => store.getStore())));
    });
  });

for (const fiberContext of [true, false]) {
  describe(`Cloudflare Telemetry fiberContext=${fiberContext}`, () => {
    const expected = fiberContext ? undefined : "request";
    const check = (
      name: string,
      run: (
        fake: ReturnType<typeof makeTracing>,
        tracer: Tracer.Tracer,
      ) => Promise<void>,
    ) =>
      test(
        name,
        () =>
          withTracing(async (fake) => {
            const tracer = await buildTracer(fiberContext);
            expect(typeof tracer.context).toBe(
              fiberContext ? "function" : "undefined",
            );
            await run(fake, tracer);
          }),
        { exclusive: true, timeout: 10_000 },
      );

    check("callback store after a sibling span", async ({ store }, tracer) => {
      const result = await Effect.runPromise(
        Effect.withTracer(
          Effect.gen(function* () {
            yield* Effect.sleep(1).pipe(Effect.withSpan("sibling"));
            return yield* readAfterCallback(store);
          }),
          tracer,
        ),
      );
      expect(result).toBe(expected);
    });

    check("callback store while a span resumes", async ({ store }, tracer) => {
      const result = await Effect.runPromise(
        Effect.withTracer(
          readAfterCallback(store).pipe(Effect.withSpan("parent")),
          tracer,
        ),
      );
      expect(result).toBe(expected);
    });

    check("callback store after its span ends", async ({ store }, tracer) => {
      const result = await Effect.runPromise(
        Effect.withTracer(
          Effect.gen(function* () {
            yield* readAfterCallback(store).pipe(Effect.withSpan("parent"));
            return yield* Effect.sync(() => store.getStore());
          }),
          tracer,
        ),
      );
      expect(result).toBe(expected);
    });

    for (const withSpan of [true, false]) {
      check(
        `promise middleware store with ${withSpan ? "a span" : "no span"}`,
        async ({ store }, tracer) => {
          const program = Effect.gen(function* () {
            yield* Effect.sleep(1);
            return yield* Effect.sync(() => store.getStore());
          });
          const result = await store.run("request", async () => {
            await Promise.resolve();
            return Effect.runPromise(
              Effect.withTracer(
                withSpan ? program.pipe(Effect.withSpan("loader")) : program,
                tracer,
              ),
            );
          });
          expect(result).toBe(expected);
        },
      );
    }

    check(
      "child spans retain their Effect parent across an async boundary",
      async ({ active, spans }, tracer) => {
        let platformParent: FakeSpan | undefined;
        await Effect.runPromise(
          Effect.withTracer(
            Effect.gen(function* () {
              yield* Effect.sleep(1);
              yield* Effect.sync(() => {
                platformParent = active.getStore();
              });
              yield* Effect.void.pipe(Effect.withSpan("child"));
            }).pipe(Effect.withSpan("parent")),
            tracer,
          ),
        );
        expect(spans.map((span) => span.name)).toEqual(["parent", "child"]);
        expect(spans[1]!.parent).toBe(spans[0]);
        expect(platformParent).toBe(fiberContext ? spans[0] : undefined);
        expect(
          spans.every(
            (span) =>
              span.ended && span.attributes["effect.exit"] === "success",
          ),
        ).toBe(true);
      },
    );

    // Start a fresh fiber from a timer after construction. Cover both
    // explicit and implicit roots beneath a later JavaScript ancestor.
    for (const root of [true, false]) {
      check(
        `late parentless span (root=${root}) uses ${fiberContext ? "invocation" : "current"} context`,
        async ({ store, spans, tracing }, tracer) => {
          await store.run(
            "request",
            () =>
              new Promise<void>((resolve) => {
                setTimeout(() => {
                  tracing.startActiveSpan("later ancestor", () => {
                    Effect.runSync(
                      Effect.withTracer(
                        Effect.void.pipe(Effect.withSpan("detached", { root })),
                        tracer,
                      ),
                    );
                  });
                  resolve();
                }, 1);
              }),
          );
          expect(spans[1]!.name).toBe("detached");
          expect(spans[1]!.store).toBe(expected);
          expect(spans[1]!.parent).toBe(fiberContext ? undefined : spans[0]);
        },
      );
    }
  });
}

for (const runtime of [false, true]) {
  for (const props of [
    {},
    { fiberContext: true },
    { fiberContext: false },
  ] satisfies CloudflareTelemetryProps[]) {
    test(
      `Telemetry registers fiberContext=${props.fiberContext ?? "default"} at ${runtime ? "runtime" : "plan time"}`,
      () =>
        withTracing(async () => {
          const previous = globalThis.__ALCHEMY_RUNTIME__;
          const bindings: Worker["Binding"][] = [];
          const host = {
            LogicalId: "TelemetryWorker",
            bind: (_id: string, data: Worker["Binding"]) =>
              Effect.sync(() => {
                bindings.push(data);
              }),
          } as Worker;
          const runtimeContext = RuntimeContext.of({
            Type: "Cloudflare.Worker",
            id: "TelemetryWorker",
            env: {},
            get: () => Effect.succeed(undefined),
            set: (id) => Effect.succeed(id),
          });
          globalThis.__ALCHEMY_RUNTIME__ = runtime;
          try {
            await Effect.runPromise(
              Effect.scoped(
                Layer.build(Telemetry(props)).pipe(
                  Effect.provideContext(
                    Context.make(
                      Context.Service<Worker, Worker>(
                        Self<Worker>("Cloudflare.Worker").key,
                      ),
                      host,
                    ).pipe(Context.add(RuntimeContext, runtimeContext)),
                  ),
                ),
              ),
            );
            expect(bindings).toEqual(
              runtime ? [] : [{ observability: { traces: { enabled: true } } }],
            );
            // The registry erases exporter requirements; this tracer layer
            // has none, as enforced by its production return type.
            const exporter = runtimeContext.telemetry as
              | Layer.Layer<never>
              | undefined;
            expect(exporter).toBeDefined();
            const tracer = await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function* () {
                  const context = yield* Layer.build(exporter!);
                  return yield* Tracer.Tracer.pipe(
                    Effect.provideContext(context),
                  );
                }),
              ),
            );
            expect(typeof tracer.context).toBe(
              props.fiberContext === false ? "undefined" : "function",
            );
          } finally {
            globalThis.__ALCHEMY_RUNTIME__ = previous;
          }
        }),
      { exclusive: true, timeout: 10_000 },
    );
  }
}
