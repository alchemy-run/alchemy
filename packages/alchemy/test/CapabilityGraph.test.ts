import { describe, expect, it } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
/**
 * What each part of a runtime can reach is recorded from its build, never
 * declared (src/CapabilityGraph.ts):
 *
 * - a binding lands on the frame current where it was bound, and a frame
 *   reaches what the Layers behind the services it looks up bound;
 * - every lookup is seen: behind `catchCause`, in a forked fiber, through
 *   `serviceOption`;
 * - a runtime built at plan time stores what its terms reach on the stack.
 */
import * as Binding from "@/Binding.ts";
import {
  calling,
  CapabilityGraph,
  CurrentPolicy,
  framed,
  makeCapabilityGraph,
  observeLayerBuilds,
  observeLookups,
  policyOf,
  recordAcquisition,
} from "@/CapabilityGraph.ts";
import { Platform } from "@/Platform.ts";
import * as Provider from "@/Provider.ts";
import type { Resource } from "@/Resource.ts";
import { InMemoryService, State } from "@/State/index.ts";
import { ModalResource, ProbeBinding, ProbeBindingLive, TestLayers } from "./test.resources.ts";

class Jobs extends Context.Service<Jobs, { readonly run: Effect.Effect<void> }>()("test/Jobs") {}
class Mail extends Context.Service<Mail, { readonly send: Effect.Effect<void> }>()("test/Mail") {}

/** A service whose Layer binds something. */
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

/** A binding whose client has a method and an Effect. */
interface Store extends Binding.Service<
  Store,
  "Test.Store",
  (name: string) => Effect.Effect<{
    readonly put: (value: string) => Effect.Effect<string>;
    readonly count: Effect.Effect<number>;
  }>
> {}
const Store = Binding.Service<Store>("Test.Store");
const StoreLive = Layer.succeed(
  Store,
  Effect.fn(function* (_name: string) {
    return { put: (value: string) => Effect.succeed(`put ${value}`), count: Effect.succeed(1) };
  }),
);

/** Run `effect` the way a runtime's program is run at plan time. */
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

describe("CapabilityGraph", { tags: ["unit"] }, () => {
  it.effect("a frame reaches what the Layers behind its lookups bound", () =>
    Effect.gen(function* () {
      const graph = makeCapabilityGraph();
      const program = Effect.gen(function* () {
        // Behind a catchCause: a probe that waits for a failure would miss it.
        yield* framed(
          "Tool",
          "park",
        )(
          Effect.catchCause(
            Effect.flatMap(Jobs, (jobs) => jobs.run),
            () => Effect.void,
          ),
        );
        // From a forked fiber, through serviceOption, and a binding of its own.
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
        yield* framed("Tool", "idle")(Effect.void);
      }).pipe(Effect.provide(Layer.mergeAll(JobsLive, MailLive)));

      yield* observed(graph, framed("Process", "Head")(program));

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
      expect(graph.ofService("test/Jobs").map((permission) => permission.binding)).toEqual([
        "Cloudflare.R2.BucketReadWrite",
      ]);

      // As a tree: the process, its tools under it, and what each reaches.
      const [head, ...rest] = graph.describe();
      expect(rest).toEqual([]);
      expect(head).toMatchObject({ kind: "Process", name: "Head" });
      expect(head!.permissions.map((permission) => permission.binding).sort()).toEqual([
        "AWS.SES.SendEmail",
        "Cloudflare.KV.NamespaceRead",
        "Cloudflare.R2.BucketReadWrite",
      ]);
      expect(
        head!.uses.map((tool) => [tool.name, tool.permissions.map((each) => each.binding)]),
      ).toEqual([
        ["idle", []],
        ["notify", ["Cloudflare.KV.NamespaceRead", "AWS.SES.SendEmail"]],
        ["park", ["Cloudflare.R2.BucketReadWrite"]],
      ]);
    }),
  );

  it.effect("a term reached through a service it provides is listed under what looks it up", () =>
    Effect.gen(function* () {
      const graph = makeCapabilityGraph();
      class Search extends Context.Service<Search, {}>()("test/Search") {}
      // A tool as a Layer: built under its own frame, where it binds.
      const SearchLive = Layer.effect(
        Search,
        framed(
          "Tool",
          "search",
        )(
          Effect.as(
            recordAcquisition({
              binding: "GitHub.SearchIssues",
              targets: ["GitHub.Repository(repo)"],
            }),
            {},
          ),
        ),
      );
      yield* observed(
        graph,
        framed("Process", "Triage")(Effect.serviceOption(Search)).pipe(Effect.provide(SearchLive)),
      );
      expect(graph.describe()).toEqual([
        {
          kind: "Process",
          name: "Triage",
          permissions: [
            {
              binding: "GitHub.SearchIssues",
              targets: ["GitHub.Repository(repo)"],
              via: ["test/Search"],
            },
          ],
          uses: [
            {
              kind: "Tool",
              name: "search",
              permissions: [
                { binding: "GitHub.SearchIssues", targets: ["GitHub.Repository(repo)"], via: [] },
              ],
              uses: [],
            },
          ],
        },
      ]);
    }),
  );

  it.effect("at runtime a tool can use only the bindings the plan listed under it", () =>
    Effect.gen(function* () {
      // The plan: `save` binds the store where it is built, `peek` binds nothing.
      const graph = makeCapabilityGraph();
      yield* observed(
        graph,
        Effect.gen(function* () {
          yield* framed("Tool", "save")(Store("notes"));
          yield* framed("Tool", "peek")(Effect.void);
        }),
      );
      const policy = policyOf(graph.describe());
      expect(policy).toEqual({
        bindings: ["Test.Store|"],
        terms: { "Tool:peek": [], "Tool:save": [0] },
      });

      // The runtime: the same client, whoever holds it.
      const store = yield* Store("notes").pipe(Effect.provideService(CurrentPolicy, policy));
      expect(yield* store.put("a")).toBe("put a");
      expect(yield* calling("Tool", "save")(store.put("b"))).toBe("put b");
      expect(yield* Effect.exit(calling("Tool", "save")(store.count))).toEqual(Exit.succeed(1));

      // `peek` closed over a client it never bound: the build could not see that.
      const denied = yield* Effect.exit(calling("Tool", "peek")(store.put("c")));
      expect(Exit.isFailure(denied) && Cause.squash(denied.cause)).toMatchObject({
        _tag: "CapabilityDenied",
        kind: "Tool",
        term: "peek",
        binding: "Test.Store",
        message:
          "Tool peek used Test.Store, which the plan does not list under it. Bind it where the tool is built.",
      });
      // A tool the plan never saw is held to nothing, and so are forked fibers of a tool.
      expect(Exit.isFailure(yield* Effect.exit(calling("Tool", "new")(store.count)))).toBe(true);
      const forked = yield* calling(
        "Tool",
        "peek",
      )(Effect.flatMap(Effect.forkChild(Effect.exit(store.count)), Fiber.join));
      expect(Exit.isFailure(forked)).toBe(true);

      // Without a policy a client is what the binding returned.
      const free = yield* Store("notes");
      expect(yield* calling("Tool", "peek")(free.put("d"))).toBe("put d");
    }).pipe(Effect.provide(StoreLive)),
  );

  it.effect("a tool reaches what a service two Layers away bound, wherever they are provided", () =>
    Effect.gen(function* () {
      class Ledger extends Context.Service<
        Ledger,
        { readonly put: (value: string) => Effect.Effect<string> }
      >()("test/Ledger") {}
      class Audit extends Context.Service<
        Audit,
        { readonly note: (value: string) => Effect.Effect<string> }
      >()("test/Audit") {}
      // Ledger binds the store. Audit only looks Ledger up. The tool only looks Audit up.
      const LedgerLive = Layer.effect(
        Ledger,
        Effect.map(Store("ledger"), (store) => ({ put: store.put })),
      );
      const AuditLive = Layer.effect(
        Audit,
        Effect.map(Ledger, (ledger) => ({ note: ledger.put })),
      );
      const tool = framed(
        "Tool",
        "audit",
      )(Effect.map(Audit, (audit) => (value: string) => audit.note(value)));
      // Each requirement is provided further out than the last.
      const built = tool.pipe(
        Effect.provide(AuditLive),
        Effect.provide(LedgerLive),
        Effect.provide(StoreLive),
      );

      const graph = makeCapabilityGraph();
      yield* observed(graph, built);
      expect(graph.ofFrame("Tool", "audit")).toEqual([
        { binding: "Test.Store", targets: [], via: ["test/Audit", "test/Ledger"] },
      ]);

      // At runtime the same build is held to that list: the tool may, another may not.
      const policy = policyOf(graph.describe());
      const handler = yield* built.pipe(Effect.provideService(CurrentPolicy, policy));
      expect(yield* calling("Tool", "audit")(handler("a"))).toBe("put a");
      expect(Exit.isFailure(yield* Effect.exit(calling("Tool", "other")(handler("b"))))).toBe(true);
    }),
  );

  it.effect("without a graph in context every recorder does nothing", () =>
    Effect.gen(function* () {
      yield* framed("Tool", "lonely")(recordAcquisition({ binding: "X", targets: [] }));
    }),
  );
});

// A runtime, reduced to what the platform does with its program.
interface Widget extends Resource<
  "Test.GraphWidget",
  { name?: string; env?: Record<string, any> },
  { name: string },
  { env?: Record<string, any> }
> {}
/** What the plan stored on the runtime, by key. */
const stored: Record<string, unknown> = {};
const Widget: any = Platform<Widget>("Test.GraphWidget", {
  createRuntimeContext: () =>
    ({
      set: (key: string, output: { readonly value: unknown }) =>
        Effect.sync(() => {
          stored[key] = output.value;
          return key;
        }),
    }) as any,
});
const providers = Layer.mergeAll(
  Provider.succeed(Widget, {
    list: () => Effect.succeed([]),
    diff: Effect.fn(function* () {
      return undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news }: any) {
      return { name: news?.name ?? id };
    }),
    delete: Effect.fn(function* () {}),
  }),
  TestLayers(),
);
const state = Layer.effect(
  State,
  Effect.sync(() => InMemoryService({})),
);
const { test } = Test.make({ providers, state });

class Probe extends Context.Service<Probe, {}>()("test/Probe") {}
/** A tool's Layer: it binds a resource the stack declares. */
const ProbeLive = Layer.effect(
  Probe,
  framed("Tool", "probe")(Effect.as(ProbeBinding(ModalResource("probed", { value: "v" })), {})),
);

class GraphWidget extends Widget()("GraphWidget") {}
const GraphWidgetLive = GraphWidget.make(
  { name: "graph" },
  // The shape of a real runtime: its Layers are provided inside the program.
  framed(
    "Process",
    "Prober",
  )(Effect.as(Effect.serviceOption(Probe), {})).pipe(
    Effect.provide(Layer.provide(ProbeLive, ProbeBindingLive)),
  ),
);

const program = Effect.gen(function* () {
  const widget = yield* GraphWidget as unknown as Effect.Effect<{ name: string }>;
  return { name: widget.name };
}).pipe(Effect.provide([GraphWidgetLive as Layer.Layer<never>]));

test.provider(
  "a plan lists a runtime's processes, their tools and what each binds",
  (stack) =>
    Effect.gen(function* () {
      const plan = yield* stack.plan(program);
      const widget = Object.values(plan.resources).find(
        (node) => node.resource.Type === "Test.GraphWidget",
      )!;
      expect(widget.capabilities).toEqual([
        {
          kind: "Process",
          name: "Prober",
          permissions: [
            {
              binding: "Test.ProbeBinding",
              targets: ["Test.ModalResource(probed)"],
              via: ["test/Probe"],
            },
          ],
          uses: [
            {
              kind: "Tool",
              name: "probe",
              permissions: [
                { binding: "Test.ProbeBinding", targets: ["Test.ModalResource(probed)"], via: [] },
              ],
              uses: [],
            },
          ],
        },
      ]);
      // The same list is stored on the runtime, where it is the limit.
      expect(JSON.parse(stored.ALCHEMY_CAPABILITIES as string)).toEqual({
        bindings: ["Test.ProbeBinding|Test.ModalResource(probed)"],
        terms: { "Process:Prober": [0], "Tool:probe": [0] },
      });
    }),
  { tags: ["unit"] },
);
