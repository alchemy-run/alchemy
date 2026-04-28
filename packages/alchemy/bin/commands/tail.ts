import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Stream from "effect/Stream";
import * as Command from "effect/unstable/cli/Command";

import { findProviderByType, type LogLine } from "../../src/Provider.ts";
import { Stage } from "../../src/Stage.ts";
import * as State from "../../src/State/index.ts";
import { loadConfigProvider } from "../../src/Util/ConfigProvider.ts";
import { fileLogger } from "../../src/Util/FileLogger.ts";

import { AuthProviders } from "../../src/Auth/AuthProvider.ts";
import { withProfileOverride } from "../../src/Auth/Profile.ts";
import {
  envFile,
  formatLocalTimestamp,
  importStack,
  instrumentCommand,
  main,
  parseResourceFilter,
  profile,
  resourceFilter,
  stage,
  TAIL_COLORS,
  TAIL_RESET,
} from "./_shared.ts";

export const tailCommand = Command.make(
  "tail",
  {
    main,
    envFile,
    stage,
    profile,
    filter: resourceFilter,
  },
  instrumentCommand(
    "tail",
    (a: { main: string; stage: string; profile: string }) => ({
      "alchemy.stage": a.stage,
      "alchemy.profile": a.profile,
      "alchemy.main": a.main,
    }),
  )(Effect.fnUntraced(function* ({ main, stage, envFile, profile, filter }) {
    const stackEffect = yield* importStack(main);

    const services = Layer.mergeAll(
      ConfigProvider.layer(
        withProfileOverride(yield* loadConfigProvider(envFile), profile),
      ),
      Layer.succeed(AuthProviders, {}),
      Layer.succeed(Stage, stage),
      Logger.layer([fileLogger("out")]),
      State.localState(),
    );

    yield* Effect.gen(function* () {
      const state = yield* State.State;
      const stack = yield* stackEffect;

      yield* Effect.gen(function* () {
        const filterSet = parseResourceFilter(filter);
        const availableIds = [
          ...new Set(Object.values(stack.resources).map((r) => r.LogicalId)),
        ].sort();

        if (filterSet) {
          for (const id of filterSet) {
            if (!availableIds.includes(id)) {
              return yield* Effect.die(
                new Error(
                  `Unknown resource '${id}' in --filter. Available: ${availableIds.join(", ") || "(none)"}`,
                ),
              );
            }
          }
        }

        const fqns = Object.keys(stack.resources);
        const tailable: {
          logicalId: string;
          stream: Stream.Stream<LogLine, any, any>;
        }[] = [];

        for (const fqn of fqns) {
          const resource = stack.resources[fqn]!;
          if (filterSet && !filterSet.has(resource.LogicalId)) continue;

          const resourceState = yield* state.get({
            stack: stack.name,
            stage: stack.stage,
            fqn,
          });
          if (!resourceState?.attr) continue;

          const provider = yield* findProviderByType(resource.Type);
          if (!provider.tail) continue;

          tailable.push({
            logicalId: resource.LogicalId,
            stream: provider.tail({
              id: resource.LogicalId,
              instanceId: resourceState.instanceId,
              props: resourceState.props as any,
              output: resourceState.attr as any,
            }),
          });
        }

        if (tailable.length === 0) {
          if (filterSet) {
            yield* Console.log(
              "No tailable resources match --filter (deploy first, or selected resources may not support tail).",
            );
          } else {
            yield* Console.log(
              "No tailable resources found. Deploy first, then run tail.",
            );
          }
          return;
        }

        yield* Console.log(
          `Tailing: ${tailable.map((t) => t.logicalId).join(", ")}`,
        );

        const taggedStreams = tailable.map(({ logicalId, stream }, i) => {
          const color = TAIL_COLORS[i % TAIL_COLORS.length]!;
          return stream.pipe(
            Stream.map(({ timestamp, message }) => {
              const ts = formatLocalTimestamp(timestamp);
              return `${color}${ts} [${logicalId}]${TAIL_RESET} ${message}`;
            }),
          );
        });

        yield* Stream.mergeAll(taggedStreams, {
          concurrency: "unbounded",
        }).pipe(Stream.runForEach((line) => Console.log(line)));
      }).pipe(Effect.provide(stack.services));
    }).pipe(Effect.provide(services));
  })),
);
