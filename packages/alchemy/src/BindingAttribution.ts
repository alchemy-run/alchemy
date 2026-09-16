/**
 * BINDING ATTRIBUTION — who acquired a binding.
 *
 * `host.bind` rows pool on the target resource (`stack.bindings[fqn]`)
 * with no record of WHICH tool/skill/agent's init acquired them. The
 * ambient attribution path fills that edge: evaluation sites (an
 * agent's charter, a ToolDef's init, a skill's tool physics) run under
 * a stamped path, and `Resource.ts`'s `bind` copies the ambient path
 * onto every row it registers. Deploy identity ignores the path
 * (`dedupeBindings` keys by sid); the raw rows keep it — the
 * permission edges of the org graph, derived from the same plan-phase
 * execution that registers the bindings themselves.
 *
 * Lives in its own module (not `Binding.ts`) because `Resource.ts`
 * must read the ambient path and `Binding.ts` already imports
 * `Resource.ts`.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** One step of the org path that led to a binding acquisition. */
export interface AttributionFrame {
  readonly kind: "Agent" | "Skill" | "Tool" | "Group";
  readonly name: string;
}

/**
 * The ambient attribution path — empty outside any stamped evaluation
 * site. A `Context.Reference`, so reading it never charges the
 * requirement channel.
 */
export const Attribution: Context.Reference<ReadonlyArray<AttributionFrame>> =
  Context.Reference("alchemy/Binding/Attribution", {
    defaultValue: (): ReadonlyArray<AttributionFrame> => [],
  });

/** Run `effect` with `frame` appended to the ambient attribution path. */
export const attributed =
  (...frames: ReadonlyArray<AttributionFrame>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(Attribution, (path) =>
      Effect.provideService(effect, Attribution, [...path, ...frames]),
    );

/**
 * One recorded binding-capability acquisition: which `Binding.Service`
 * was resolved, against which resource(s), under which org path. The
 * permission edge of the org graph, captured where the acquisition
 * actually runs — the plan-phase Layer build AND the isolate's boot
 * build (`host.bind` is plan-only, but the acquisition itself runs in
 * both), so a deployed Worker can serve its own permission table.
 */
export interface Acquisition {
  /** The `Binding.Service`'s key (e.g. `alchemy/GitHub/GetIssue`). */
  readonly binding: string;
  /** The target resources' identities (`Type(logicalId)`). */
  readonly targets: ReadonlyArray<string>;
  /** The ambient org path at acquisition ([Agent, Skill?, Tool]). */
  readonly path: ReadonlyArray<AttributionFrame>;
}

/**
 * An OPTIONAL registry of {@link Acquisition}s. When provided (an org
 * host serving its own graph — `Layer.sync(AcquisitionRegistry, …)`),
 * every `Binding.Service` call records into it; absent, recording is
 * a no-op. Rows de-dupe on (binding, targets, path).
 */
export class AcquisitionRegistry extends Context.Service<
  AcquisitionRegistry,
  {
    readonly record: (row: Acquisition) => void;
    readonly list: () => ReadonlyArray<Acquisition>;
  }
>()("alchemy/Binding/AcquisitionRegistry") {}

/** An in-memory {@link AcquisitionRegistry} implementation. */
export const makeAcquisitionRegistry = (): {
  record: (row: Acquisition) => void;
  list: () => ReadonlyArray<Acquisition>;
} => {
  const rows = new Map<string, Acquisition>();
  return {
    record: (row) => {
      const key = `${row.binding}|${row.targets.join(",")}|${row.path
        .map((frame) => `${frame.kind}:${frame.name}`)
        .join("/")}`;
      if (!rows.has(key)) rows.set(key, row);
    },
    list: () => [...rows.values()],
  };
};
