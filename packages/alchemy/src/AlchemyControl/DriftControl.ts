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
import { ArtifactStore, createArtifactStore } from "../Artifacts.ts";
import { AuthProviders } from "../Auth/AuthProvider.ts";
import type { ApplyEvent } from "../Cli/Event.ts";
import { withProfileOverride } from "../Auth/Profile.ts";
import { Stage } from "../Stage.ts";
import * as Sync from "../Sync.ts";
import { loadConfigProvider } from "../Util/ConfigProvider.ts";
import { fileLogger } from "../Util/FileLogger.ts";
import * as Operation from "./Operation.ts";
import type { ControlContext } from "./ControlContext.ts";
import { internalize } from "./ControlEffect.ts";
import { importStack } from "./StackSession.ts";
import { summarizePlan } from "./PlanSummary.ts";
import {
  ControlNotFound,
  StaleRevision,
  type DriftId,
  type PlanId,
  type PlanRevision,
  type RepairDriftInput,
  type StackTarget,
  makeDriftId,
  makePlanId,
  makePlanRevision,
  randomUuid,
} from "./Surface.ts";

export const RepairEvent = Operation.eventSchema(
  { ApplyEvent: { event: Schema.Any } },
  Schema.Any,
);
export type RepairEvent =
  | { readonly _tag: "ApplyEvent"; readonly event: ApplyEvent }
  | { readonly _tag: "Succeeded"; readonly result: unknown };

interface StoredDrift {
  readonly revision: string;
  readonly stack: AwaitedStack;
  readonly services: Layer.Layer<
    AdoptPolicy | ArtifactStore | AuthProviders | Stage,
    PlatformError,
    AlchemyContext | FileSystem.FileSystem | Path.Path
  >;
}

type AwaitedStack = Effect.Success<
  Effect.Success<ReturnType<typeof importStack>>
>;

export const makeDriftControl = () =>
  Effect.gen(function* () {
    const context = yield* Effect.context<ControlContext>();
    const snapshots = new Map<DriftId, StoredDrift>();

    const inspect = (target: StackTarget) =>
      internalize(
        Effect.gen(function* () {
          const stackEffect = yield* importStack(target.entrypoint);
          const valueServices = Layer.succeedContext(
            Context.make(AdoptPolicy, false).pipe(
              Context.add(ArtifactStore, createArtifactStore()),
              Context.add(
                AuthProviders,
                yield* Effect.serviceOption(AuthProviders).pipe(
                  Effect.map(Option.getOrElse(() => ({}))),
                ),
              ),
              Context.add(Stage, target.stage),
            ),
          );
          const services = Layer.mergeAll(
            valueServices,
            ConfigProvider.layer(
              withProfileOverride(
                yield* loadConfigProvider(Option.fromNullishOr(target.envFile)),
                target.profile,
              ),
            ),
            Logger.layer([fileLogger("out")], { mergeWithExisting: true }),
          );
          const stack = yield* stackEffect.pipe(Effect.provide(services));
          const { result, plan } = yield* Sync.plan({
            name: stack.name,
            stage: stack.stage,
          }).pipe(Effect.provide(stack.services), Effect.provide(services));
          const id = yield* makeDriftId;
          const revision = yield* randomUuid;
          snapshots.set(id, { revision, stack, services });
          const planId = yield* makePlanId;
          const planRevision = yield* makePlanRevision;
          return {
            id,
            revision,
            stack: { name: stack.name, stage: stack.stage },
            resources: Object.values(result.resources)
              .filter((resource) => resource.action !== "skipped")
              .map((resource) => ({
                fqn: resource.fqn,
                logicalId: resource.logicalId,
                resourceType: resource.resourceType,
                status:
                  resource.action === "unchanged"
                    ? ("in-sync" as const)
                    : resource.action === "missing"
                      ? ("missing" as const)
                      : ("drifted" as const),
                actual: resource.attr,
              })),
            repairPlan: {
              id: planId,
              revision: planRevision,
              stack: { name: stack.name, stage: stack.stage },
              operation: "deploy" as const,
              resources: [],
              summary: summarizePlan(plan),
              diagnostics: [],
              createdAt: new Date(yield* Clock.currentTimeMillis),
              native: plan,
            },
          };
        }).pipe(Effect.provide(context)),
      );

    const repair = ({ driftId, revision }: RepairDriftInput) =>
      Effect.gen(function* () {
        const stored = snapshots.get(driftId);
        if (stored === undefined) {
          return yield* Effect.fail(
            new ControlNotFound({ kind: "drift", id: driftId }),
          );
        }
        if (stored.revision !== revision) {
          return yield* Effect.fail(
            new StaleRevision({ expected: revision, actual: stored.revision }),
          );
        }
        return yield* Operation.make(
          (
            emit: (event: {
              readonly _tag: "ApplyEvent";
              readonly event: ApplyEvent;
            }) => Effect.Effect<void>,
          ) => {
            const session = {
              emit: (event: ApplyEvent) => emit({ _tag: "ApplyEvent", event }),
              done: () => Effect.void,
            };
            return Sync.sync(
              { name: stored.stack.name, stage: stored.stack.stage },
              { session },
            ).pipe(
              Effect.provide(stored.stack.services),
              Effect.provide(stored.services),
              Effect.provide(context),
              internalize,
            );
          },
        );
      });

    return { inspect, repair };
  });

/** Drift inspection and repair operations. */
export class DriftControl extends Context.Service<
  DriftControl,
  Effect.Success<ReturnType<typeof makeDriftControl>>
>()("alchemy/AlchemyControl/Drift") {}

/** Live drift control implementation. */
export const DriftControlLive = Layer.effect(DriftControl, makeDriftControl());
