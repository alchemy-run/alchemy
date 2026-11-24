import { describe, expect, it } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
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
import {
  CapabilityGraph,
  framed,
  makeCapabilityGraph,
  observeLayerBuilds,
  observeLookups,
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
const Widget: any = Platform<Widget>("Test.GraphWidget", {
  createRuntimeContext: () => ({}) as any,
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
    }),
  { tags: ["unit"] },
);
