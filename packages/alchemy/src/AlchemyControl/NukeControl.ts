import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import picomatch from "picomatch";
import {
  isProviderCollectionService,
  isProviderService,
  type ProviderService,
} from "../Provider.ts";
import type { ProviderMode } from "../ProviderMode.ts";
import * as Operation from "./Operation.ts";
import type { ControlContext } from "./ControlContext.ts";
import { internalize } from "./ControlEffect.ts";
import { buildStackProviders } from "./StackSession.ts";
import {
  ControlNotFound,
  ProviderFailure,
  StaleRevision,
  makeNukeResourceId,
  makeNukeScanId,
  randomUuid,
  type ExecuteNukeInput,
  type NukeResourceId,
  type NukeResult,
  type NukeScanId,
  type NukeScanInput,
} from "./Surface.ts";

export const ExecuteEvent = Operation.eventSchema(
  { NukeResourceCompleted: { resource: Schema.String } },
  Schema.Any,
);

interface DiscoveredProvider {
  readonly id: string;
  readonly resolve: Effect.Effect<ProviderService>;
}

interface StoredResource {
  readonly id: NukeResourceId;
  readonly providerId: string;
  readonly displayName: string;
  readonly attributes: Record<string, unknown>;
  readonly provider: ProviderService;
}

interface StoredScan {
  readonly revision: string;
  readonly context: Context.Context<never>;
  readonly resources: ReadonlyArray<StoredResource>;
}

const discover = (
  context: Context.Context<never>,
  mode: ProviderMode,
): ReadonlyArray<DiscoveredProvider> => {
  const output = new Map<string, ProviderService>();
  const nukeable = (provider: ProviderService) =>
    !provider.nuke?.singleton && !provider.nuke?.skip;
  for (const [key, value] of context.mapUnsafe.entries()) {
    if (isProviderCollectionService(value)) {
      for (const [id, provider] of Object.entries(value.providers)) {
        if (nukeable(provider)) output.set(id, provider);
      }
    } else if (
      typeof key === "string" &&
      key.includes(".") &&
      isProviderService(value) &&
      nukeable(value)
    ) {
      output.set(key, value);
    }
  }
  return [...output.entries()]
    .flatMap(([id, provider]) => {
      if (mode === "live") return [{ id, resolve: Effect.succeed(provider) }];
      return provider.modes?.local
        ? [{ id, resolve: provider.modes.local }]
        : [];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
};

const nameKeys = [
  "workerName",
  "functionName",
  "bucketName",
  "tableName",
  "queueName",
  "repositoryName",
  "databaseName",
  "projectName",
  "domainName",
  "hostname",
  "displayName",
  "name",
];

const displayName = (attributes: Record<string, unknown>) =>
  nameKeys
    .map((key) => attributes[key])
    .find(
      (value): value is string => typeof value === "string" && value.length > 0,
    ) ??
  Object.values(attributes).find(
    (value): value is string => typeof value === "string" && value.length > 0,
  ) ??
  "unknown";

const groupBy = <T>(items: ReadonlyArray<T>, key: (item: T) => string) => {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const id = key(item);
    groups.set(id, [...(groups.get(id) ?? []), item]);
  }
  return groups;
};

const addEdge = (edges: Map<string, Set<string>>, from: string, to: string) => {
  const values = edges.get(from) ?? new Set<string>();
  values.add(to);
  edges.set(from, values);
};

const components = (
  nodes: ReadonlyArray<string>,
  successors: Map<string, Set<string>>,
) => {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const output: string[][] = [];
  let next = 0;
  const visit = (node: string): void => {
    index.set(node, next);
    low.set(node, next++);
    stack.push(node);
    onStack.add(node);
    for (const successor of successors.get(node) ?? []) {
      if (!index.has(successor)) {
        visit(successor);
        low.set(node, Math.min(low.get(node)!, low.get(successor)!));
      } else if (onStack.has(successor)) {
        low.set(node, Math.min(low.get(node)!, index.get(successor)!));
      }
    }
    if (low.get(node) !== index.get(node)) return;
    const component: string[] = [];
    for (;;) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    output.push(component);
  };
  for (const node of nodes) if (!index.has(node)) visit(node);
  return output;
};

const failure = (
  provider: string,
  operation: string,
  cause: unknown,
): ProviderFailure =>
  new ProviderFailure({
    provider,
    operation,
    error: {
      tag: "Unknown",
      message: String(cause),
      details: cause,
    },
  });

const session = {
  emit: () => Effect.void,
  done: () => Effect.void,
  note: () => Effect.void,
};

export const makeNukeControl = () =>
  Effect.gen(function* () {
    const ambient = yield* Effect.context<ControlContext>();
    const scans = new Map<NukeScanId, StoredScan>();

    const scan = (input: NukeScanInput) =>
      Effect.gen(function* () {
        const debug = !!process.env.DEBUG;
        const built = yield* buildStackProviders({
          main: input.entrypoint,
          envFile: Option.fromNullishOr(input.envFile),
          profile: input.profile,
          logger: debug ? Logger.layer([Logger.defaultLogger]) : undefined,
          extra: Layer.succeed(MinimumLogLevel, debug ? "Debug" : "Info"),
        });
        const context = built.context as Context.Context<never>;
        const include = input.include?.length
          ? picomatch([...input.include])
          : () => true;
        const exclude = input.exclude?.length
          ? picomatch([...input.exclude])
          : () => false;
        const selected = discover(context, input.mode).filter(
          ({ id }) => include(id) && !exclude(id),
        );
        const failures: ProviderFailure[] = [];
        const resources: StoredResource[] = [];
        yield* Effect.forEach(
          selected,
          ({ id, resolve }) =>
            Effect.gen(function* () {
              const result = yield* Effect.result(
                Effect.gen(function* () {
                  const provider = yield* resolve;
                  const listed = yield* provider
                    .list()
                    .pipe(
                      Effect.timeout(
                        Duration.seconds(input.providerTimeoutSeconds ?? 120),
                      ),
                    );
                  return { provider, listed };
                }).pipe(Effect.provide(context)),
              );
              if (result._tag === "Failure") {
                failures.push(failure(id, "list", result.failure));
                return;
              }
              for (const raw of result.success.listed) {
                const attributes = (raw ?? {}) as Record<string, unknown>;
                resources.push({
                  id: yield* makeNukeResourceId,
                  providerId: id,
                  displayName: displayName(attributes),
                  attributes,
                  provider: result.success.provider,
                });
              }
            }),
          { concurrency: input.concurrency ?? 16, discard: true },
        );
        const id = yield* makeNukeScanId;
        const revision = yield* randomUuid;
        scans.set(id, { revision, context, resources });
        return {
          id,
          revision,
          mode: input.mode,
          resources: resources.map(({ provider: _, ...resource }) => resource),
          failures,
        };
      }).pipe(Effect.provide(ambient), internalize);

    const execute = (input: ExecuteNukeInput) =>
      Effect.gen(function* () {
        const stored = scans.get(input.scanId);
        if (stored === undefined) {
          return yield* Effect.fail(
            new ControlNotFound({ kind: "nuke scan", id: input.scanId }),
          );
        }
        if (stored.revision !== input.revision) {
          return yield* Effect.fail(
            new StaleRevision({
              expected: input.revision,
              actual: stored.revision,
            }),
          );
        }
        const selected = new Set(input.resources);
        const targets = stored.resources.filter(({ id }) => selected.has(id));
        return yield* Operation.make(
          (
            emit: (event: {
              readonly _tag: "NukeResourceCompleted";
              readonly resource: NukeResourceId;
            }) => Effect.Effect<void>,
          ) =>
            Effect.gen(function* () {
              const deleted: NukeResourceId[] = [];
              const failed: Array<NukeResult["failed"][number]> = [];
              const held: Array<NukeResult["held"][number]> = [];
              let passes = 0;
              const attempt = (resource: StoredResource) =>
                resource.provider
                  .delete({
                    id: resource.displayName,
                    fqn: resource.displayName,
                    instanceId: "",
                    olds: resource.attributes as never,
                    output: resource.attributes as never,
                    session,
                    bindings: [],
                    force: true,
                  })
                  .pipe(
                    Effect.timeout(
                      Duration.seconds(input.providerTimeoutSeconds ?? 120),
                    ),
                    Effect.provide(stored.context),
                  );

              if (input.strategy._tag === "independent") {
                passes = 1;
                yield* Effect.forEach(
                  targets,
                  (resource) =>
                    Effect.result(
                      attempt(resource).pipe(
                        Effect.retry({
                          schedule: Schedule.min([
                            Schedule.exponential("1 second"),
                            Schedule.spaced("15 seconds"),
                          ]),
                          times:
                            input.strategy._tag === "independent"
                              ? input.strategy.retries
                              : 0,
                        }),
                      ),
                    ).pipe(
                      Effect.tap((result) =>
                        Effect.sync(() => {
                          if (result._tag === "Success")
                            deleted.push(resource.id);
                          else
                            failed.push({
                              resource: resource.id,
                              failure: failure(
                                resource.providerId,
                                "delete",
                                result.failure,
                              ),
                            });
                        }),
                      ),
                      Effect.tap(() =>
                        emit({
                          _tag: "NukeResourceCompleted",
                          resource: resource.id,
                        }),
                      ),
                    ),
                  { concurrency: input.concurrency ?? 16, discard: true },
                );
              } else {
                const typeIds = [
                  ...new Set(targets.map(({ providerId }) => providerId)),
                ];
                const providerOf = new Map(
                  targets.map(({ providerId, provider }) => [
                    providerId,
                    provider,
                  ]),
                );
                const successors = new Map<string, Set<string>>();
                const predecessors = new Map<string, Set<string>>();
                for (const id of typeIds) {
                  const globs = providerOf.get(id)?.nuke?.dependsOn;
                  if (!globs?.length) continue;
                  const matches = picomatch([...globs]);
                  for (const other of typeIds) {
                    if (other === id || !matches(other)) continue;
                    addEdge(successors, id, other);
                    addEdge(predecessors, other, id);
                  }
                }
                const grouped = components(typeIds, successors);
                const componentOf = new Map<string, number>();
                grouped.forEach((component, index) =>
                  component.forEach((id) => componentOf.set(id, index)),
                );
                const layerOf = grouped.map(() => 0);
                for (let index = grouped.length - 1; index >= 0; index--) {
                  for (const id of grouped[index]!) {
                    for (const predecessor of predecessors.get(id) ?? []) {
                      const predecessorComponent =
                        componentOf.get(predecessor)!;
                      if (predecessorComponent !== index) {
                        layerOf[index] = Math.max(
                          layerOf[index]!,
                          layerOf[predecessorComponent]! + 1,
                        );
                      }
                    }
                  }
                }
                const waves: string[][] = [];
                grouped.forEach((component, index) =>
                  (waves[layerOf[index]!] ??= []).push(...component),
                );
                const byType = groupBy(targets, ({ providerId }) => providerId);
                const remainingCount = new Map(
                  [...byType].map(([id, resources]) => [id, resources.length]),
                );
                for (const wave of waves) {
                  let runnable: StoredResource[] = [];
                  for (const typeId of wave) {
                    const resources = byType.get(typeId) ?? [];
                    const blockers = [
                      ...(predecessors.get(typeId) ?? []),
                    ].filter(
                      (predecessor) =>
                        componentOf.get(predecessor) !==
                          componentOf.get(typeId) &&
                        (remainingCount.get(predecessor) ?? 0) > 0,
                    );
                    if (blockers.length > 0) {
                      held.push(
                        ...resources.map((resource) => ({
                          resource: resource.id,
                          blockedBy: blockers,
                        })),
                      );
                    } else runnable = [...runnable, ...resources];
                  }
                  let remaining = runnable;
                  while (remaining.length > 0) {
                    passes += 1;
                    const results = yield* Effect.forEach(
                      remaining,
                      (resource) =>
                        Effect.result(attempt(resource)).pipe(
                          Effect.map((result) => ({ resource, result })),
                        ),
                      { concurrency: input.concurrency ?? 16 },
                    );
                    const next = results.flatMap(({ resource, result }) => {
                      if (result._tag === "Success") {
                        deleted.push(resource.id);
                        return [];
                      }
                      return [resource];
                    });
                    if (next.length === remaining.length) {
                      for (const resource of next) {
                        failed.push({
                          resource: resource.id,
                          failure: failure(
                            resource.providerId,
                            "delete",
                            "no progress after coordinated pass",
                          ),
                        });
                      }
                      break;
                    }
                    remaining = next;
                  }
                  const failuresByType = groupBy(
                    failed.map(({ resource }) =>
                      targets.find(({ id }) => id === resource)!,
                    ),
                    ({ providerId }) => providerId,
                  );
                  for (const typeId of wave) {
                    remainingCount.set(
                      typeId,
                      failuresByType.get(typeId)?.length ?? 0,
                    );
                  }
                }
              }
              return {
                requested: targets.length,
                deleted,
                failed,
                held,
                passes,
              } satisfies NukeResult;
            }),
        );
      });

    return { scan, execute };
  });

/** Unsafe provider-wide resource discovery and deletion operations. */
export class NukeControl extends Context.Service<
  NukeControl,
  Effect.Success<ReturnType<typeof makeNukeControl>>
>()("alchemy/AlchemyControl/Nuke") {}

/** Live nuke control implementation. */
export const NukeControlLive = Layer.effect(NukeControl, makeNukeControl());
