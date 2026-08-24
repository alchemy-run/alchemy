import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AuthProviders } from "../Auth/AuthProvider.ts";
import { withProfileOverride } from "../Auth/Profile.ts";
import { findProviderByType } from "../Provider.ts";
import { stampedMode } from "../ProviderMode.ts";
import { Stage } from "../Stage.ts";
import * as State from "../State/index.ts";
import { loadConfigProvider } from "../Util/ConfigProvider.ts";
import { fileLogger } from "../Util/FileLogger.ts";
import { importStack } from "./StackSession.ts";
import type { ControlContext } from "./ControlContext.ts";
import { internalize } from "./ControlEffect.ts";
import {
  ControlInternalError,
  type ControlError,
  InvalidControlInput,
  type LogEntry,
  type LogResource,
  type QueryLogsInput,
  type StackTarget,
  type TailLogsInput,
} from "./Surface.ts";

const identity = (
  fqn: string,
  resource: { LogicalId: string; Type: string },
) => ({
  fqn,
  logicalId: resource.LogicalId,
  resourceType: resource.Type,
});

export const makeLogControl = Effect.gen(function* () {
  const context = yield* Effect.context<ControlContext>();

  const open = Effect.fn(function* (target: StackTarget) {
    const stackEffect = yield* importStack(target.entrypoint);
    const services = Layer.mergeAll(
      ConfigProvider.layer(
        withProfileOverride(
          yield* loadConfigProvider(Option.fromNullishOr(target.envFile)),
          target.profile,
        ),
      ),
      Layer.succeed(AuthProviders, {}),
      Layer.succeed(Stage, target.stage),
      Logger.layer([fileLogger("out")], { mergeWithExisting: true }),
      State.localState(),
    );
    const stack = yield* stackEffect.pipe(Effect.provide(services));
    return { stack, services };
  });

  const selectedResources = <
    A extends { target: StackTarget; resources?: ReadonlyArray<string> },
  >(
    input: A,
  ) =>
    Effect.gen(function* () {
      const session = yield* open(input.target);
      const selected = new Set(input.resources ?? []);
      const available = [
        ...new Set(
          Object.values(session.stack.resources).map(
            (resource) => resource.LogicalId,
          ),
        ),
      ].sort();
      const unknown = [...selected].find((name) => !available.includes(name));
      if (unknown !== undefined) {
        return yield* Effect.fail(
          new InvalidControlInput({
            field: "resources",
            message: `Unknown resource '${unknown}'. Available: ${available.join(", ") || "(none)"}`,
          }),
        );
      }
      return { ...session, selected };
    });

  const resources = (target: StackTarget) =>
    internalize(
      Effect.gen(function* () {
        const { stack, services } = yield* open(target);
        return yield* Effect.gen(function* () {
          const stateService = yield* State.State;
          const state = yield* stateService;
          const result: LogResource[] = [];
          for (const [fqn, resource] of Object.entries(stack.resources)) {
            const stored = yield* state.get({
              stack: stack.name,
              stage: stack.stage,
              fqn,
            });
            if (!State.isResourceState(stored) || stored.attr === undefined)
              continue;
            const provider = yield* findProviderByType(
              resource.Type,
              stampedMode(stored),
            );
            result.push({
              ...identity(fqn, resource),
              supportsQuery: provider.logs !== undefined,
              supportsTail: provider.tail !== undefined,
            });
          }
          return result;
        }).pipe(Effect.provide(stack.services), Effect.provide(services));
      }).pipe(Effect.provide(context)),
    );

  const entries = (input: QueryLogsInput) =>
    internalize(
      Effect.gen(function* () {
        const { stack, services, selected } = yield* selectedResources(input);
        return yield* Effect.gen(function* () {
          const stateService = yield* State.State;
          const state = yield* stateService;
          const entries: LogEntry[] = [];
          for (const [fqn, resource] of Object.entries(stack.resources)) {
            if (selected.size > 0 && !selected.has(resource.LogicalId))
              continue;
            const stored = yield* state.get({
              stack: stack.name,
              stage: stack.stage,
              fqn,
            });
            if (!State.isResourceState(stored) || stored.attr === undefined)
              continue;
            const provider = yield* findProviderByType(
              resource.Type,
              stampedMode(stored),
            );
            if (!provider.logs) continue;
            const lines = yield* provider.logs({
              id: resource.LogicalId,
              fqn,
              instanceId: stored.instanceId,
              props: stored.props,
              output: stored.attr,
              options: { limit: input.limit ?? 100, since: input.since },
            });
            entries.push(
              ...lines.map((line) => ({
                resource: identity(fqn, resource),
                timestamp: line.timestamp,
                message: line.message,
              })),
            );
          }
          return entries.sort(
            (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
          );
        }).pipe(Effect.provide(stack.services), Effect.provide(services));
      }).pipe(Effect.provide(context)),
    );

  const tail = (input: TailLogsInput): Stream.Stream<LogEntry, ControlError> =>
    Stream.unwrap(
      internalize(
        Effect.gen(function* () {
          const { stack, services, selected } = yield* selectedResources(input);
          return yield* Effect.gen(function* () {
            const stateService = yield* State.State;
            const state = yield* stateService;
            const streams: Array<
              Stream.Stream<LogEntry, ControlInternalError>
            > = [];
            for (const [fqn, resource] of Object.entries(stack.resources)) {
              if (selected.size > 0 && !selected.has(resource.LogicalId))
                continue;
              const stored = yield* state.get({
                stack: stack.name,
                stage: stack.stage,
                fqn,
              });
              if (!State.isResourceState(stored) || stored.attr === undefined)
                continue;
              const provider = yield* findProviderByType(
                resource.Type,
                stampedMode(stored),
              );
              if (!provider.tail) continue;
              streams.push(
                provider
                  .tail({
                    id: resource.LogicalId,
                    fqn,
                    instanceId: stored.instanceId,
                    props: stored.props,
                    output: stored.attr,
                  })
                  .pipe(
                    Stream.provide(stack.services),
                    Stream.provide(services),
                    Stream.provide(context),
                    Stream.map((line) => ({
                      resource: identity(fqn, resource),
                      timestamp: line.timestamp,
                      message: line.message,
                    })),
                    Stream.mapError(
                      (cause) =>
                        new ControlInternalError({
                          message: String(cause),
                          cause,
                        }),
                    ),
                  ),
              );
            }
            return Stream.mergeAll(streams, { concurrency: "unbounded" });
          }).pipe(Effect.provide(stack.services), Effect.provide(services));
        }).pipe(Effect.provide(context)),
      ),
    );

  return { resources, entries, tail };
});

/** Stack log discovery, querying, and streaming operations. */
export class LogControl extends Context.Service<
  LogControl,
  Effect.Success<typeof makeLogControl>
>()("alchemy/AlchemyControl/Logs") {}

/** Live log control implementation. */
export const LogControlLive = Layer.effect(LogControl, makeLogControl);
