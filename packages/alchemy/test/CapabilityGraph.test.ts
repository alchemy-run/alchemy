/**
 * THE CAPABILITY GRAPH — permissions derived from the build, never
 * declared (src/CapabilityGraph.ts).
 *
 * Pinned here:
 * - a `Binding.Service` acquisition lands on the frame CURRENT where it
 *   ran, and a frame's closure follows every service it looked up to
 *   the Layer that provided it — so a tool that `yield* Jobs` owns the
 *   bucket `JobsLive` bound, even though the Layer was provided to the
 *   agent, outside the tool's init;
 * - the lookup observer is COMPLETE: lookups behind `catchCause`, in
 *   forked fibers, through `serviceOption` and nested `Effect.provide`
 *   are all attributed;
 * - the AI frames: an Agent's closure rolls up its ToolDefs' inits; a
 *   Skill's closure reaches its class tools' physics; a class tool's
 *   physics answers `ofService`.
 */
import * as AI from "@/AI/index.ts";
import { DriverLocal } from "@/AI/DriverLocal.ts";
import { ThreadStorageMemory } from "@/AI/ThreadStorageMemory.ts";
import {
  CapabilityGraph,
  framed,
  makeCapabilityGraph,
  observeLayerBuilds,
  observeLookups,
  recordAcquisition,
  type CapabilityGraphShape,
} from "@/CapabilityGraph.ts";
import * as Alchemy from "@/index.ts";
import { Platform } from "@/Platform.ts";
import * as Provider from "@/Provider.ts";
import type { Resource } from "@/Resource.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { InMemoryService, State } from "@/State/index.ts";
import * as Test from "@/Test/Alchemy";
import { describe, expect, it } from "alchemy-test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import * as Model from "./AI/fixtures/ScriptedModel.ts";
import {
  Archives,
  ArchivesLive,
  Scholar,
  ScholarCharter,
  Search,
} from "./AI/fixtures/researcher.ts";
import { ModalResource, ProbeBinding, TestLayers } from "./test.resources.ts";

const InMemoryDriver = DriverLocal.pipe(Layer.provide(ThreadStorageMemory));

class Jobs extends Context.Service<
  Jobs,
  { readonly run: Effect.Effect<void> }
>()("test/Jobs") {}
class Mail extends Context.Service<
  Mail,
  { readonly send: Effect.Effect<void> }
>()("test/Mail") {}

/** A service whose Layer acquires a capability — the JobService shape. */
const JobsLive = Layer.effect(
  Jobs,
  Effect.gen(function* () {
    yield* recordAcquisition({
      binding: "Cloudflare.R2.BucketReadWrite",
      targets: ["Cloudflare.R2.Bucket(jobs)"],
    });
    return { run: Effect.void };
  }),
);
const MailLive = Layer.effect(
  Mail,
  Effect.gen(function* () {
    yield* recordAcquisition({ binding: "AWS.SES.SendEmail", targets: [] });
    return { send: Effect.void };
  }),
);

/** Run `effect` the way the platform runs an `impl`: observed lookups,
 *  framed Layer builds, the graph in context. */
const observed = <A, E, R>(
  graph: ReturnType<typeof makeCapabilityGraph>,
  effect: Effect.Effect<A, E, R>,
) =>
  observeLookups(graph)(effect).pipe(
    Effect.provideService(
      Layer.CurrentMemoMap,
      observeLayerBuilds(Layer.makeMemoMapUnsafe(), graph),
    ),
    Effect.provideService(CapabilityGraph, graph),
  );

/* ── the platform end to end ─────────────────────────────────────────
 *
 * A tagged platform resource (the Worker/Function shape, reduced to
 * the harness of platform-missing-impl.test.ts) whose init builds an
 * agent with a ToolDef that binds a capability over a resource the
 * Stack resolves. The platform installs the graph, frames the memo
 * map, observes the lookups; init reads the graph back the way a
 * route would. */

interface Widget extends Resource<
  "Test.GraphWidget",
  { name?: string; env?: Record<string, any> },
  { name: string },
  { env?: Record<string, any> }
> {}

const Widget: any = Platform<Widget>("Test.GraphWidget", {
  createRuntimeContext: () => ({}) as any,
});

const widgetProvider = Provider.succeed(Widget, {
  list: () => Effect.succeed([]),
  diff: Effect.fn(function* () {
    return undefined;
  }),
  reconcile: Effect.fn(function* ({ id, news }: any) {
    return { name: news?.name ?? id };
  }),
  delete: Effect.fn(function* () {}),
});

const providers = Layer.mergeAll(widgetProvider, TestLayers());
const state = Layer.effect(
  State,
  Effect.sync(() => InMemoryService({})),
);
const { test, deploy } = Test.make({ providers, state });

class Prober extends AI.Agent<Prober>()("Prober") {}
const probe = AI.Tool("probe")`Probe the thing.`(
  Effect.gen(function* () {
    // a real Binding.Service over a resource the Stack resolves
    const client = yield* ProbeBinding(ModalResource("probed", { value: "v" }));
    return Effect.fn(function* (_: {}) {
      return { plane: yield* client() };
    });
  }),
);
const ProberLive = Prober.make`You PROBE. ${probe} does it.`;

/** The graph init saw — read back after the deploy. */
let seen: CapabilityGraphShape | undefined;

class GraphWidget extends Widget()("GraphWidget") {}
const GraphWidgetLive = GraphWidget.make(
  { name: "graph" },
  Effect.gen(function* () {
    seen = yield* CapabilityGraph;
    // the shape of a real host: services provided INSIDE init
    yield* Effect.flatMap(Prober, () => Effect.void).pipe(
      Effect.provide(
        ProberLive.pipe(
          Layer.provide(
            InMemoryDriver.pipe(Layer.provide(Model.make([]).layer)),
          ),
        ),
      ),
      Effect.provide(RuntimeContext.phantom),
    );
    return {};
  }),
);

const GraphStack = Alchemy.Stack(
  "CapabilityGraphStack",
  { providers, state },
  Effect.gen(function* () {
    const widget = yield* GraphWidget as unknown as Effect.Effect<{
      name: string;
    }>;
    return { name: widget.name };
  }).pipe(Effect.provide([GraphWidgetLive as Layer.Layer<never>])),
);

describe("CapabilityGraph", () => {
  it.effect(
    "a frame's closure follows its lookups to the providing Layer's acquisitions",
    () =>
      Effect.gen(function* () {
        const graph = makeCapabilityGraph();
        const program = Effect.gen(function* () {
          // `park` reaches Jobs — behind a catchCause, the blind spot of
          // any failure-driven probe
          yield* framed(
            "Tool",
            "park",
          )(
            Effect.catchCause(
              Effect.flatMap(Jobs, (jobs) => jobs.run),
              () => Effect.void,
            ),
          );
          // `notify` reaches Mail from a FORKED fiber and acquires a
          // capability of its own, directly
          yield* framed(
            "Tool",
            "notify",
          )(
            Effect.gen(function* () {
              const fiber = yield* Effect.forkChild(
                Effect.flatMap(Effect.serviceOption(Mail), () => Effect.void),
              );
              yield* Fiber.join(fiber);
              yield* recordAcquisition({
                binding: "Cloudflare.KV.NamespaceRead",
                targets: ["Cloudflare.KV.Namespace(cache)"],
              });
            }),
          );
          // `idle` looks nothing up
          yield* framed("Tool", "idle")(Effect.void);
        }).pipe(Effect.provide(Layer.mergeAll(JobsLive, MailLive)));

        yield* observed(graph, framed("Agent", "Head")(program));

        expect(graph.ofFrame("Tool", "park")).toEqual([
          {
            binding: "Cloudflare.R2.BucketReadWrite",
            targets: ["Cloudflare.R2.Bucket(jobs)"],
            via: ["test/Jobs"],
          },
        ]);
        expect(graph.ofFrame("Tool", "notify")).toEqual([
          {
            binding: "Cloudflare.KV.NamespaceRead",
            targets: ["Cloudflare.KV.Namespace(cache)"],
            via: [],
          },
          { binding: "AWS.SES.SendEmail", targets: [], via: ["test/Mail"] },
        ]);
        expect(graph.ofFrame("Tool", "idle")).toEqual([]);
        // the agent rolls up its tools (children frames)
        expect(
          graph
            .ofFrame("Agent", "Head")
            .map((permission) => permission.binding)
            .sort(),
        ).toEqual([
          "AWS.SES.SendEmail",
          "Cloudflare.KV.NamespaceRead",
          "Cloudflare.R2.BucketReadWrite",
        ]);
        // a service's own reach: what its Layer acquired, directly
        expect(graph.ofService("test/Jobs")).toEqual([
          {
            binding: "Cloudflare.R2.BucketReadWrite",
            targets: ["Cloudflare.R2.Bucket(jobs)"],
            via: [],
          },
        ]);
        expect(graph.ofFrame("Tool", "unknown")).toEqual([]);
      }),
  );

  test(
    "a Binding.Service call records the binding over its target resource on the current frame",
    Effect.gen(function* () {
      const graph = makeCapabilityGraph();
      yield* observed(
        graph,
        framed(
          "Tool",
          "probe",
        )(
          // the deferred form: an un-yielded constructor keeps its
          // static identity, resolved without a Stack
          ProbeBinding(ModalResource("thing", { value: "v" })),
        ).pipe(Effect.provide(TestLayers())),
      );
      expect(graph.ofFrame("Tool", "probe")).toEqual([
        {
          binding: "Test.ProbeBinding",
          targets: ["Test.ModalResource(thing)"],
          via: [],
        },
      ]);
    }),
  );

  it.effect("without a graph in context every recorder is a no-op", () =>
    Effect.gen(function* () {
      const result = yield* framed(
        "Tool",
        "x",
      )(
        Effect.flatMap(recordAcquisition({ binding: "b", targets: [] }), () =>
          Effect.succeed(42),
        ),
      );
      expect(result).toBe(42);
    }),
  );

  it.effect(
    "an Agent's closure rolls up its ToolDefs; a ToolDef reaches the service its init resolved",
    () =>
      Effect.gen(function* () {
        const graph = makeCapabilityGraph();
        const key = AI.Thing("key", S.String)`The record's key.`;
        const park = AI.Tool("park")`Park ${key} on the job queue.`(
          Effect.gen(function* () {
            const jobs = yield* Jobs;
            return Effect.fn(function* (_: { key: string }) {
              yield* jobs.run;
              return {};
            });
          }),
        );
        class Curator extends AI.Agent<Curator>()("Curator") {}
        const CuratorLive = Curator.make`
          You are the CURATOR. ${park} files records.`;
        const model = Model.make([]);

        yield* observed(
          graph,
          Effect.flatMap(Curator, () => Effect.void).pipe(
            Effect.provide(
              CuratorLive.pipe(
                Layer.provide(JobsLive),
                Layer.provide(InMemoryDriver.pipe(Layer.provide(model.layer))),
              ),
            ),
            Effect.provide(RuntimeContext.phantom),
          ),
        );

        expect(graph.ofFrame("Tool", "park")).toEqual([
          {
            binding: "Cloudflare.R2.BucketReadWrite",
            targets: ["Cloudflare.R2.Bucket(jobs)"],
            via: ["test/Jobs"],
          },
        ]);
        expect(graph.ofFrame("Agent", "Curator")).toEqual([
          {
            binding: "Cloudflare.R2.BucketReadWrite",
            targets: ["Cloudflare.R2.Bucket(jobs)"],
            via: ["test/Jobs"],
          },
        ]);
        // the tool's frame is the agent's child
        const frames = graph.frames();
        const tool = frames.find((f) => f.kind === "Tool" && f.name === "park");
        expect(tool?.parent?.kind).toBe("Agent");
        expect(tool?.parent?.name).toBe("Curator");
      }),
  );

  test(
    "end to end: a platform host records its agents' reach through a real deploy",
    Effect.gen(function* () {
      seen = undefined;
      yield* deploy(GraphStack);
      expect(seen).toBeDefined();
      const graph = seen!;
      // the tool's init bound the capability over the resource the STACK
      // resolved — the row names the resource's identity
      expect(graph.ofFrame("Tool", "probe")).toEqual([
        {
          binding: "Test.ProbeBinding",
          targets: ["Test.ModalResource(probed)"],
          via: [],
        },
      ]);
      // the agent rolls its tool up; its frame is a Layer frame's child
      expect(graph.ofFrame("Agent", "Prober")).toEqual(
        graph.ofFrame("Tool", "probe"),
      );
      const agent = graph
        .frames()
        .find((f) => f.kind === "Agent" && f.name === "Prober");
      expect(agent?.parent?.kind).toBe("Layer");
      // the agent's Layer is what the fork built — its key is recorded
      expect(graph.ofService(Prober.key)).toEqual(
        graph.ofFrame("Tool", "probe"),
      );
    }),
  );

  it.effect(
    "a Skill's closure reaches its class tools' physics; the physics answers ofService",
    () =>
      Effect.gen(function* () {
        const graph = makeCapabilityGraph();
        // the class tool's PHYSICS: a Layer whose build acquires
        const SearchLive = Layer.effect(
          Search,
          Effect.gen(function* () {
            yield* recordAcquisition({
              binding: "Cloudflare.AI.SearchQuery",
              targets: ["Cloudflare.AI.Search(corpus)"],
            });
            return ((input: { query: string }) =>
              Effect.succeed({
                results: `results for ${input.query}`,
              })) as never;
          }),
        );
        const ScholarLive = Scholar.make(ScholarCharter);
        const model = Model.make([]);

        yield* observed(
          graph,
          Effect.flatMap(Scholar, () => Effect.void).pipe(
            Effect.provide(
              ScholarLive.pipe(
                Layer.provide(ArchivesLive.pipe(Layer.provide(SearchLive))),
                Layer.provide(InMemoryDriver.pipe(Layer.provide(model.layer))),
              ),
            ),
            Effect.provide(RuntimeContext.phantom),
          ),
        );

        expect(graph.ofService(Search.key)).toEqual([
          {
            binding: "Cloudflare.AI.SearchQuery",
            targets: ["Cloudflare.AI.Search(corpus)"],
            via: [],
          },
        ]);
        expect(graph.ofFrame("Skill", Archives["~alchemy/Name"])).toEqual([
          {
            binding: "Cloudflare.AI.SearchQuery",
            targets: ["Cloudflare.AI.Search(corpus)"],
            via: [Search.key],
          },
        ]);
        expect(
          graph
            .frames()
            .some((f) => f.kind === "Agent" && f.name === "Scholar"),
        ).toBe(true);
      }),
  );
});
