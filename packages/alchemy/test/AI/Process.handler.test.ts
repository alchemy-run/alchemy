/**
 * The deterministic handler path (reassess §C): `AI.process(term,
 * handler)` lifts plain Effect code into a term's full ProcessService —
 * mailbox, dispatch = send + await, run.admitted/run.settled, and
 * dispatch to child agents — with no model loop in the coordination
 * path. The judgment (if any) is a leaf the code calls, not the loop.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import * as Stream from "effect/Stream";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import type * as Response from "effect/unstable/ai/Response";
import * as AI from "@/AI/index.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";

// ─── a member agent (scripted) + a deterministic coordinator ─────

const q = AI.Parameter("q", S.String)`the question`;
class Grep extends AI.Tool<Grep>()("grep")`Search for ${q}.` {}
class Sage extends AI.Agent<Sage>()("Sage")`
You are Sage. Answer using ${Grep}.` {}

const topic = AI.Parameter("topic", S.String)`what to look into`;
// a prose-free goal term: refs (halt) only, no charter — its ProcessService
// is implemented by a HANDLER, not a model loop
class Desk extends AI.Process<Desk>()("Desk")`
${AI.until(S.String)`the desk has answered`}` {}

// a typed broadcast the desk may publish (kernel-internal source), and
// a term whose bare ${X} mention IS the publish grant (canon §2a)
const Routed = AI.EventSource(
  "desk.routed",
  S.Struct({ to: S.String, reason: S.String }),
);
class RoutingDesk extends AI.Process<RoutingDesk>()("RoutingDesk")`
Route each question; publish ${Routed} to announce the route.
${AI.until(S.String)`the desk has answered`}` {}

const usage = {
  inputTokens: {
    uncached: undefined,
    total: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const finish = (reason: string): Response.StreamPartEncoded =>
  ({ type: "finish", reason, usage, response: undefined }) as never;
const text = (t: string): Array<Response.StreamPartEncoded> =>
  [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: t },
    { type: "text-end", id: "t1" },
  ] as never;

const scriptedModel = (turns: Array<Array<Response.StreamPartEncoded>>) => {
  let n = 0;
  return Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () => Effect.die(new Error("streamText only")),
      streamText: () => Stream.fromIterable(turns[n++] ?? []),
    }),
  );
};

describe("AI.process — deterministic handler", () => {
  it.effect("dispatch runs the handler, which dispatches a child agent", () =>
    Effect.gen(function* () {
      const posted: Array<{ author: string; text: string }> = [];

      // the coordinator: PLAIN Effect code. No model in the routing path.
      const DeskLive = AI.process(Desk, (item, ctx) =>
        Effect.gen(function* () {
          const sage = yield* Sage;
          yield* ctx.emit("routing", { to: "Sage" });
          const answer = (yield* sage.dispatch(
            `look into: ${String(item)}`,
          )) as { text?: string };
          yield* ctx.post("Sage", String(answer.text ?? answer));
          return `desk answered: ${String(item)}`;
        }),
      );

      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const desk = yield* Desk;
          return yield* desk.dispatch("caching strategy");
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            DeskLive.pipe(
              Layer.provide([
                AI.memory.pipe(
                  Layer.provide(
                    scriptedModel([[...text("use an LRU"), finish("stop")]]),
                  ),
                ),
                AI.layer(Sage).pipe(
                  Layer.provide([
                    AI.memory.pipe(
                      Layer.provide(
                        scriptedModel([
                          [...text("use an LRU"), finish("stop")],
                        ]),
                      ),
                    ),
                    Layer.succeed(Grep, (() => Effect.succeed("hit")) as never),
                    RuntimeContext.phantom,
                  ]),
                ),
                RuntimeContext.phantom,
              ]),
            ),
            RuntimeContext.phantom,
          ),
        ),
      );

      // the handler's return value is the run's Out (typed exit)
      expect(outcome).toBe("desk answered: caching strategy");
    }),
  );

  it.effect("the handler's run writes admitted/settled to the Trace", () =>
    Effect.gen(function* () {
      const DeskLive = AI.process(Desk, (item, ctx) =>
        Effect.gen(function* () {
          const child = yield* ctx.run("Sage", Effect.succeed("child answer"));
          yield* ctx.post("Sage", child);
          return `ack: ${String(item)}`;
        }),
      );
      // the kernel Layer still requires a model even though this handler
      // never calls one — provide an (unused) scripted model
      const kernelLayer = AI.memory.pipe(Layer.provide(scriptedModel([])));
      const trace = yield* Effect.scoped(
        Effect.gen(function* () {
          const kernel = yield* AI.Kernel;
          const desk = yield* Desk;
          yield* desk.dispatch("hello");
          return yield* Stream.runCollect(
            kernel
              .trace("Desk")
              .pipe(Stream.takeUntil((e) => e.type === "run.settled")),
          );
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            DeskLive.pipe(Layer.provide([kernelLayer, RuntimeContext.phantom])),
            kernelLayer,
            RuntimeContext.phantom,
          ),
        ),
      );
      const types = trace.map((e) => e.type);
      expect(types[0]).toBe("run.admitted");
      expect(types).toContain("child.started");
      expect(types).toContain("child.completed");
      expect(types).toContain("message.posted");
      expect(types.at(-1)).toBe("run.settled");
      expect((trace[0]!.payload as any).item).toBe("hello");
    }),
  );

  it.effect(
    "effectful constructor resolves deps once; typed ctx.emit rows the Trace AND publishes",
    () =>
      Effect.gen(function* () {
        // the effectful-constructor form: dependencies resolve ONCE at
        // Layer build; the returned handler closes over them
        let builds = 0;
        const DeskLive = AI.process(
          RoutingDesk,
          Effect.gen(function* () {
            const sage = yield* Sage;
            builds++;
            return (item: unknown, ctx: AI.ProcessContext) =>
              Effect.gen(function* () {
                // typed emit: payload checked against Routed's schema
                yield* ctx.emit(Routed, {
                  to: "Sage",
                  reason: "depth",
                });
                yield* sage.dispatch(`look into: ${String(item)}`);
                return `answered: ${String(item)}`;
              });
          }),
        );

        const kernelLayer = AI.memory.pipe(
          Layer.provide([
            scriptedModel([
              [...text("use an LRU"), finish("stop")],
              [...text("use an LRU"), finish("stop")],
            ]),
            AI.EventBusMemory,
          ]),
        );

        const { published, trace, answers } = yield* Effect.scoped(
          Effect.gen(function* () {
            const kernel = yield* AI.Kernel;
            const bus = yield* AI.EventBus;
            const desk = yield* RoutingDesk;
            // subscribe BEFORE dispatch: the typed publication must be
            // observable on the bus (one durable row + one publication)
            const routed = yield* bus.subscribe(Routed);
            const first = yield* desk.dispatch("caching");
            const second = yield* desk.dispatch("sharding");
            const published = yield* Stream.runCollect(
              routed.pipe(Stream.take(2)),
            );
            const trace = yield* Stream.runCollect(
              kernel
                .trace("RoutingDesk")
                .pipe(Stream.takeUntil((e) => e.type === "run.settled")),
            );
            return { published, trace, answers: [first, second] };
          }),
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              DeskLive.pipe(
                Layer.provide([
                  kernelLayer,
                  AI.EventBusMemory,
                  AI.layer(Sage).pipe(
                    Layer.provide([
                      kernelLayer,
                      Layer.succeed(Grep, (() =>
                        Effect.succeed("hit")) as never),
                      RuntimeContext.phantom,
                    ]),
                  ),
                  RuntimeContext.phantom,
                ]),
              ),
              kernelLayer,
              AI.EventBusMemory,
              RuntimeContext.phantom,
            ),
          ),
        );

        // the constructor Effect ran once, not once per run
        expect(builds).toBe(1);
        expect(answers).toEqual(["answered: caching", "answered: sharding"]);
        // the typed publication reached the bus, schema-shaped
        expect([...published]).toEqual([
          { to: "Sage", reason: "depth" },
          { to: "Sage", reason: "depth" },
        ]);
        // …and the SAME fact is one durable Trace row
        const emitted = [...trace].find((e) => e.type === "message.emitted");
        expect(emitted).toBeDefined();
        expect(emitted!.payload).toEqual({
          source: "desk.routed",
          event: { to: "Sage", reason: "depth" },
        });
      }),
  );

  it("a bare event mention joins the declared published language (topology)", () => {
    const [node] = AI.topology(RoutingDesk);
    expect(node!.emits).toEqual(["desk.routed"]);
    // and the desk that declares nothing publishes nothing (statically)
    const [plain] = AI.topology(Desk);
    expect(plain!.emits).toEqual([]);
  });
});

void topic;
