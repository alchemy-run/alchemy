import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { Path } from "effect/Path";
import { Command, Flag } from "effect/unstable/cli";
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
  parseSince,
  resourceFilter,
  stage,
  TAIL_COLORS,
  TAIL_RESET,
} from "./_shared.ts";

const logsLimit = Flag.integer("limit").pipe(
  Flag.withDescription("Number of log entries to fetch"),
  Flag.withDefault(100),
);

const logsSince = Flag.string("since").pipe(
  Flag.withDescription(
    "Fetch logs since this time (e.g. '1h', '30m', '2024-01-01T00:00:00Z')",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

export const logsCommand = Command.make(
  "logs",
  {
    main,
    envFile,
    stage,
    filter: resourceFilter,
    limit: logsLimit,
    since: logsSince,
  },
  Effect.fnUntraced(function* ({
    main,
    stage,
    envFile,
    filter,
    limit,
    since,
  }: {
    main: string;
    stage: string;
    envFile: Option.Option<string>;
    filter: string | undefined;
    limit: number;
    since: string | undefined;
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

    const sinceDate = since ? parseSince(since) : undefined;

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
        const allLogs: { logicalId: string; lines: LogLine[] }[] = [];

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
          if (!provider.logs) continue;

          const lines = yield* provider.logs({
            id: resource.LogicalId,
            instanceId: resourceState.instanceId,
            props: resourceState.props as any,
            output: resourceState.attr as any,
            options: { limit, since: sinceDate },
          });

          allLogs.push({ logicalId: resource.LogicalId, lines });
        }

        if (allLogs.length === 0) {
          if (filterSet) {
            yield* Console.log(
              "No resources with logs match --filter (deploy first, or selected resources may not expose logs).",
            );
          } else {
            yield* Console.log(
              "No resources with logs found. Deploy first, then run logs.",
            );
          }
          return;
        }

        const merged = allLogs
          .flatMap(({ logicalId, lines }, i) => {
            const color = TAIL_COLORS[i % TAIL_COLORS.length]!;
            return lines.map((line) => ({
              ...line,
              formatted: `${color}${formatLocalTimestamp(line.timestamp)} [${logicalId}]${TAIL_RESET} ${line.message}`,
            }));
          })
          .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

        for (const entry of merged) {
          yield* Console.log(entry.formatted);
        }
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
