import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import type * as Option from "effect/Option";
import { Path } from "effect/Path";
import * as Stream from "effect/Stream";
import { Command } from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { dotAlchemy } from "../../src/Config.ts";
import { findProviderByType, type LogLine } from "../../src/Provider.ts";
import * as Stack from "../../src/Stack.ts";
import { Stage } from "../../src/Stage.ts";
import * as State from "../../src/State/index.ts";
import { loadConfigProvider } from "../../src/Util/ConfigProvider.ts";
import { fileLogger } from "../../src/Util/FileLogger.ts";
import { PlatformServices } from "../../src/Util/PlatformServices.ts";

import {
  envFile,
  formatLocalTimestamp,
  main,
  parseResourceFilter,
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
    filter: resourceFilter,
  },
  Effect.fnUntraced(function* ({
    main,
    stage,
    envFile,
    filter,
  }: {
    main: string;
    stage: string;
    envFile: Option.Option<string>;
    filter: string | undefined;
  }) {
    const path = yield* Path;
    const module = yield* Effect.promise(
      () => import(path.resolve(process.cwd(), main)),
    );
    const stackEffect = module.default as ReturnType<
      ReturnType<typeof Stack.make>
    >;
    if (!stackEffect) {
      return yield* Effect.die(
        new Error(
          `Main file '${main}' must export a default stack definition (export default defineStack({...}))`,
        ),
      );
    }

    const configProvider = yield* loadConfigProvider(envFile);

    const platform = Layer.mergeAll(PlatformServices, FetchHttpClient.layer);

    const rootLogger = Logger.layer([fileLogger("out")]);

    const alchemy = Layer.mergeAll(
      State.LocalState,
      Layer.provideMerge(rootLogger, dotAlchemy),
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
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          alchemy,
          Layer.mergeAll(platform, Layer.succeed(Stage, stage)),
        ),
      ),
      Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
      Effect.scoped,
    ) as Effect.Effect<void, any, never>;
  }),
);
