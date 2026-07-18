/**
 * The owner-sensitivity gate (canon §2a ruling 4): affordances follow
 * ownership. A **world-owned** source (a provider-catalog constructor
 * like `GitHub.IssueOpened(repo)` — the world publishes it, a process
 * never can) affords nothing by bare mention: it renders as vocabulary,
 * joins no `emits` topology, and `ctx.emit` of it is a defect. An
 * **org-internal** source keeps the unmarked-grant rule: its bare
 * mention IS the publish grant.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import * as Stream from "effect/Stream";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as AI from "@/AI/index.ts";
import * as GitHub from "@/GitHub/index.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";

// the deferred resource form — the ONE way a repository is named
const repo = GitHub.Repository("world-owned-alchemy-effect", {
  owner: "alchemy-run",
  name: "alchemy-effect",
});

// a world-owned catalog source (the CORE GitHub catalog marks all of
// its constructors `owner: "world"`)
const IssueOpened = GitHub.IssueOpened(repo);

// an org-internal broadcast: the unmarked mention is the publish grant
const PostRouted = AI.Event("org.post.routed", S.Struct({ to: S.String }));

// mentions BOTH bare: the org source is granted, the world source is
// vocabulary. Note this compiles with no event Layer anywhere — event
// refs contribute nothing to Req (the type-level half of the gate).
class Desk extends AI.Process<Desk>()("WorldDesk")`
Watch the repository: ${IssueOpened} names what arrives; announce your
routing decisions by publishing ${PostRouted}.
${AI.until(S.String)`the desk has answered`}` {}

const scriptedModel = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: () => Effect.die(new Error("streamText only")),
    streamText: () => Stream.fromIterable([]),
  }),
);
const kernelLayer = AI.memory.pipe(Layer.provide(scriptedModel));
// the publish test needs the kernel and the test to observe ONE bus:
// EventBusMemory is memoized by reference across the Layer graph
const kernelWithBus = AI.memory.pipe(
  Layer.provide([scriptedModel, AI.EventBusMemory]),
);

describe("world-owned event sources (canon §2a ruling 4)", () => {
  it("the catalog constructors are marked world-owned", () => {
    expect(AI.isWorldOwned(IssueOpened)).toBe(true);
    expect(AI.isWorldOwned(GitHub.IssueClosed(repo))).toBe(true);
    expect(AI.isWorldOwned(PostRouted)).toBe(false);
  });

  it("topology: a mentioned world source joins no emits; the org mention still grants", () => {
    const [node] = AI.topology(Desk);
    expect(node!.emits).toEqual(["org.post.routed"]);
  });

  it("render: the world-owned bare mention still renders the event's name (vocabulary)", () => {
    const [node] = AI.topology(Desk);
    expect(node!.prose).toContain(
      "github.issues.opened/alchemy-run/alchemy-effect",
    );
    expect(node!.prose).toContain("org.post.routed");
  });

  it.effect("ctx.emit of a world-owned source is a defect", () =>
    Effect.gen(function* () {
      const DeskLive = AI.process(Desk, (_item, ctx) =>
        Effect.gen(function* () {
          yield* ctx.emit(IssueOpened, {
            _tag: "IssueOpened",
            repository: {
              name: "alchemy-effect",
              owner: { login: "alchemy-run" },
            },
            issue: { number: 1, title: "t" },
          });
          return "unreachable";
        }),
      );

      const exit = yield* Effect.scoped(
        Effect.gen(function* () {
          const desk = yield* Desk;
          return yield* Effect.exit(desk.dispatch("route this"));
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            DeskLive.pipe(Layer.provide([kernelLayer, RuntimeContext.phantom])),
            RuntimeContext.phantom,
          ),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      const squashed = Cause.squash(
        (exit as Exit.Failure<unknown, unknown>).cause,
      );
      expect(String(squashed)).toContain("world-owned");
      expect(String(squashed)).toContain("github.issues.opened");
    }),
  );

  it.effect("ctx.emit of an org-internal source still publishes", () =>
    Effect.gen(function* () {
      const DeskLive = AI.process(Desk, (_item, ctx) =>
        Effect.gen(function* () {
          yield* ctx.emit(PostRouted, { to: "Sage" });
          return "answered";
        }),
      );

      const { outcome, published } = yield* Effect.scoped(
        Effect.gen(function* () {
          const bus = yield* AI.EventBus;
          const desk = yield* Desk;
          const routed = yield* bus.subscribe(PostRouted);
          const outcome = yield* desk.dispatch("route this");
          const published = yield* Stream.runCollect(
            routed.pipe(Stream.take(1)),
          );
          return { outcome, published };
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            DeskLive.pipe(
              Layer.provide([
                kernelWithBus,
                AI.EventBusMemory,
                RuntimeContext.phantom,
              ]),
            ),
            AI.EventBusMemory,
            RuntimeContext.phantom,
          ),
        ),
      );

      expect(outcome).toBe("answered");
      expect([...published]).toEqual([{ to: "Sage" }]);
    }),
  );
});
