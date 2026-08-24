import * as ConfigProvider from "effect/ConfigProvider";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { AdoptPolicy } from "../AdoptPolicy.ts";
import { AlchemyContext } from "../AlchemyContext.ts";
import { apply } from "../Apply.ts";
import type { ApplyEvent } from "../Cli/Event.ts";
import { ArtifactStore, createArtifactStore } from "../Artifacts.ts";
import { AuthProviders } from "../Auth/AuthProvider.ts";
import { withProfileOverride } from "../Auth/Profile.ts";
import * as Plan from "../Plan.ts";
import { Stage } from "../Stage.ts";
import { fileLogger } from "../Util/FileLogger.ts";
import { loadConfigProvider } from "../Util/ConfigProvider.ts";
import * as Operation from "./Operation.ts";
import { internalize } from "./ControlEffect.ts";
import { importStack } from "./StackSession.ts";
import { summarizePlan } from "./PlanSummary.ts";
import {
  ControlInternalError,
  ControlNotFound,
  type ApplyPlanInput,
  type ControlError,
  type PlanId,
  type PlanRevision,
  type PlanSnapshot,
  type PlanStackInput,
  type PlanningEvent,
  type ReconcileDevInput,
  makePlanId,
  makePlanRevision,
} from "./Surface.ts";

export const PlanEvent = Operation.eventSchema(
  {
    PlanningPhaseChanged: {
      phase: Schema.Literals([
        "importing-module",
        "resolving-services",
        "loading-state",
        "computing-plan",
        "plan-ready",
      ]),
      message: Schema.String,
    },
  },
  Schema.Any,
);

export type PlanEvent =
  | PlanningEvent
  | { readonly _tag: "Succeeded"; readonly result: PlanSnapshot };

export const ApplyOperationEvent = Operation.eventSchema(
  { ApplyEvent: { event: Schema.Any } },
  Schema.Any,
);

export type ApplyOperationEvent =
  | { readonly _tag: "ApplyEvent"; readonly event: ApplyEvent }
  | { readonly _tag: "Succeeded"; readonly result: unknown };

interface StoredPlan {
  readonly revision: PlanRevision;
  readonly native: Plan.Plan;
  readonly stack: AwaitedStack;
  readonly services: Layer.Layer<
    AdoptPolicy | AlchemyContext | ArtifactStore | AuthProviders | Stage,
    PlatformError,
    AlchemyContext | FileSystem.FileSystem | Path.Path
  >;
}

type AwaitedStack = Effect.Success<
  Effect.Success<ReturnType<typeof importStack>>
>;

const eventSession = (
  emit: (event: {
    readonly _tag: "ApplyEvent";
    readonly event: ApplyEvent;
  }) => Effect.Effect<void>,
) => ({
  emit: (event: ApplyEvent) => emit({ _tag: "ApplyEvent", event }),
  done: () => Effect.void,
});

export const makeStackLifecycle = () => {
  const plans = new Map<PlanId, StoredPlan>();

  const makePlan = Effect.fn(function* (
    input: PlanStackInput & {
      readonly report?: (event: PlanningEvent) => Effect.Effect<void>;
    },
    dev = false,
  ) {
    const report = input.report ?? (() => Effect.void);
    yield* report({
      _tag: "PlanningPhaseChanged",
      phase: "importing-module",
      message: "Importing stack module",
    });
    const stackEffect = yield* importStack(input.target.entrypoint);
    yield* report({
      _tag: "PlanningPhaseChanged",
      phase: "resolving-services",
      message: "Resolving stack services",
    });
    const valueServices = Layer.succeedContext(
      Context.make(AdoptPolicy, input.adopt ?? false).pipe(
        Context.add(ArtifactStore, createArtifactStore()),
        Context.add(
          AuthProviders,
          yield* Effect.serviceOption(AuthProviders).pipe(
            Effect.map(Option.getOrElse(() => ({}))),
          ),
        ),
        Context.add(Stage, input.target.stage),
      ),
    );
    const services = Layer.mergeAll(
      Layer.effect(
        AlchemyContext,
        AlchemyContext.pipe(
          Effect.map((context) => ({
            ...context,
            dev,
            adopt: input.adopt ?? false,
            updateStateStore: input.updateStateStore ?? false,
          })),
        ),
      ),
      valueServices,
      ConfigProvider.layer(
        withProfileOverride(
          yield* loadConfigProvider(Option.fromNullishOr(input.target.envFile)),
          input.target.profile,
        ),
      ),
      Logger.layer([fileLogger("out")], { mergeWithExisting: true }),
    );
    const stack = yield* stackEffect.pipe(Effect.provide(services));
    yield* report({
      _tag: "PlanningPhaseChanged",
      phase: "loading-state",
      message: "Loading stack state",
    });
    yield* report({
      _tag: "PlanningPhaseChanged",
      phase: "computing-plan",
      message: "Computing plan",
    });
    const native = yield* (
      input.operation === "destroy"
        ? Plan.destroy(stack)
        : Plan.make(stack, { force: input.force })
    ).pipe(Effect.provide(stack.services), Effect.provide(services));
    const id = yield* makePlanId;
    const nextRevision = yield* makePlanRevision;
    plans.set(id, { revision: nextRevision, native, stack, services });
    const snapshot = {
      id,
      revision: nextRevision,
      stack: { name: stack.name, stage: stack.stage },
      operation: input.operation,
      resources: [],
      summary: summarizePlan(native),
      diagnostics: [],
      createdAt: new Date(yield* Clock.currentTimeMillis),
      native,
    } satisfies PlanSnapshot;
    yield* report({
      _tag: "PlanningPhaseChanged",
      phase: "plan-ready",
      message: "Plan ready",
    });
    return snapshot;
  });

  const applyPlan = ({ planId: id, revision: expected }: ApplyPlanInput) =>
    Effect.gen(function* () {
      const stored = plans.get(id);
      if (stored === undefined) {
        return yield* Effect.fail(new ControlNotFound({ kind: "plan", id }));
      }
      if (stored.revision !== expected) {
        return yield* Effect.fail(
          new ControlInternalError({ message: "Plan revision is stale" }),
        );
      }
      return yield* Operation.make(
        (
          emit: (event: {
            readonly _tag: "ApplyEvent";
            readonly event: ApplyEvent;
          }) => Effect.Effect<void>,
        ) =>
          apply(stored.native, {
            session: eventSession(emit),
          }).pipe(
            Effect.provide(stored.stack.services),
            Effect.provide(stored.services),
            internalize,
          ),
      );
    });

  const reconcile = (input: ReconcileDevInput) =>
    Operation.make(
      (
        emit: (
          event:
            | { readonly _tag: "PlanReady"; readonly snapshot: PlanSnapshot }
            | { readonly _tag: "ApplyEvent"; readonly event: ApplyEvent },
        ) => Effect.Effect<void>,
      ) =>
        Effect.gen(function* () {
          const snapshot = yield* makePlan(
            {
              target: input.target,
              operation: "deploy",
              force: input.force,
              updateStateStore: true,
            },
            true,
          );
          yield* emit({ _tag: "PlanReady", snapshot });
          const stored = plans.get(snapshot.id)!;
          return yield* apply(stored.native, {
            session: eventSession(emit),
          }).pipe(
            Effect.provide(stored.stack.services),
            Effect.provide(stored.services),
            internalize,
          );
        }),
    );

  const plan = (input: PlanStackInput) =>
    Operation.make((emit: (event: PlanningEvent) => Effect.Effect<void>) =>
      internalize(makePlan({ ...input, report: emit })),
    );

  return {
    plan,
    deploy: applyPlan,
    destroy: {
      plan: (input: Omit<PlanStackInput, "operation">) =>
        plan({ ...input, operation: "destroy" }),
      apply: applyPlan,
    },
    dev: { reconcile },
  };
};

/** Stack planning, deployment, destruction, and development operations. */
export class StackControl extends Context.Service<
  StackControl,
  ReturnType<typeof makeStackLifecycle>
>()("alchemy/AlchemyControl/Stack") {}

/** Live stack control implementation. */
export const StackControlLive = Layer.effect(
  StackControl,
  Effect.sync(makeStackLifecycle),
);
