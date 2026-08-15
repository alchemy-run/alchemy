import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";

import { findProviderByType, type LogLine } from "../../Provider.ts";
import { stampedMode } from "../../ProviderMode.ts";
import { Stage } from "../../Stage.ts";
import * as State from "../../State/index.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { fileLogger } from "../../Util/FileLogger.ts";

import { AuthProviders } from "../../Auth/AuthProvider.ts";
import { withProfileOverride } from "../../Auth/Profile.ts";
import { paint } from "../CliKit/index.ts";
import {
  envFile,
  formatLocalTimestamp,
  importStack,
  instrumentCommand,
  parseSince,
  profile,
  config,
  stage,
  TAIL_COLORS,
} from "./_shared.ts";

const logsLimit = Flag.integer("limit").pipe(
  Flag.withDescription("Number of log entries to fetch (default: 100)"),
  Flag.withDefault(100),
);

const follow = Flag.boolean("follow").pipe(
  Flag.withAlias("f"),
  Flag.withDescription("Continue streaming new log entries"),
  Flag.withDefault(false),
);

const resources = Flag.string("resource").pipe(
  Flag.withAlias("r"),
  Flag.withDescription(
    "Comma-separated logical resource IDs to include (for example Worker,Api)",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
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
    main: config,
    envFile,
    stage,
    profile,
    resources,
    limit: logsLimit,
    since: logsSince,
    follow,
  },
  instrumentCommand(
    "logs",
    (a: {
      main: string;
      stage: string;
      profile: string | undefined;
      limit: number;
      follow: boolean;
    }) => ({
      "alchemy.stage": a.stage,
      "alchemy.profile": a.profile ?? "",
      "alchemy.main": a.main,
      "alchemy.limit": a.limit,
      "alchemy.follow": a.follow,
    }),
  )(
    Effect.fn(function* ({
      main,
      stage,
      envFile,
      profile,
      resources,
      limit,
      since,
      follow,
    }) {
      const stackEffect = yield* importStack(main);

      const services = Layer.mergeAll(
        ConfigProvider.layer(
          withProfileOverride(yield* loadConfigProvider(envFile), profile),
        ),
        Layer.succeed(AuthProviders, {}),
        Layer.succeed(Stage, stage),
        Logger.layer([fileLogger("out")], { mergeWithExisting: true }),
        State.localState(),
      );

      const sinceDate = since ? parseSince(since) : undefined;

      yield* Effect.gen(function* () {
        const stack = yield* stackEffect;

        yield* Effect.gen(function* () {
          const state = yield* yield* State.State;
          const selected = new Set(
            (resources ?? "")
              .split(",")
              .map((resource) => resource.trim())
              .filter((resource) => resource.length > 0),
          );
          const availableIds = [
            ...new Set(Object.values(stack.resources).map((r) => r.LogicalId)),
          ].sort();

          if (selected.size > 0) {
            for (const id of selected) {
              if (!availableIds.includes(id)) {
                return yield* Effect.die(
                  new Error(
                    `Unknown resource '${id}' in --resource. Available: ${availableIds.join(", ") || "(none)"}`,
                  ),
                );
              }
            }
          }

          const fqns = Object.keys(stack.resources);
          if (follow) {
            const streams: {
              logicalId: string;
              stream: Stream.Stream<LogLine, unknown, unknown>;
            }[] = [];
            for (const fqn of fqns) {
              const resource = stack.resources[fqn]!;
              if (selected.size > 0 && !selected.has(resource.LogicalId))
                continue;
              const resourceState = yield* state.get({
                stack: stack.name,
                stage: stack.stage,
                fqn,
              });
              if (!(resourceState as any)?.attr) continue;
              const provider = yield* findProviderByType(
                resource.Type,
                stampedMode(resourceState as any),
              );
              if (!provider.tail) continue;
              streams.push({
                logicalId: resource.LogicalId,
                stream: provider.tail({
                  id: resource.LogicalId,
                  fqn,
                  instanceId: (resourceState as any).instanceId,
                  props: (resourceState as any).props,
                  output: (resourceState as any).attr,
                }),
              });
            }
            if (streams.length === 0) {
              yield* Console.log("No matching resources support live logs.");
              return;
            }
            yield* Console.log(
              `Following: ${streams.map(({ logicalId }) => logicalId).join(", ")}`,
            );
            yield* Stream.mergeAll(
              streams.map(({ logicalId, stream }, index) => {
                const color = TAIL_COLORS[index % TAIL_COLORS.length]!;
                return stream.pipe(
                  Stream.map(
                    (line) =>
                      `${paint(color, `${formatLocalTimestamp(line.timestamp)} [${logicalId}]`)} ${line.message}`,
                  ),
                );
              }),
              { concurrency: "unbounded" },
            ).pipe(Stream.runForEach((line) => Console.log(line)));
            return;
          }

          const allLogs: { logicalId: string; lines: LogLine[] }[] = [];

          for (const fqn of fqns) {
            const resource = stack.resources[fqn]!;
            if (selected.size > 0 && !selected.has(resource.LogicalId))
              continue;

            const resourceState = yield* state.get({
              stack: stack.name,
              stage: stack.stage,
              fqn,
            });
            if (!(resourceState as any)?.attr) continue;

            // Query with the provider variant of the mode that deployed the
            // row (a local dev worker's logs come from the local provider).
            const provider = yield* findProviderByType(
              resource.Type,
              stampedMode(resourceState as any),
            );
            if (!provider.logs) continue;

            const lines = yield* provider.logs({
              id: resource.LogicalId,
              fqn,
              instanceId: (resourceState as any).instanceId,
              props: (resourceState as any).props,
              output: (resourceState as any).attr,
              options: { limit, since: sinceDate },
            });

            allLogs.push({ logicalId: resource.LogicalId, lines });
          }

          if (allLogs.length === 0) {
            if (selected.size > 0) {
              yield* Console.log(
                "No resources with logs match --resource (deploy first, or selected resources may not expose logs).",
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
                formatted: `${paint(color, `${formatLocalTimestamp(line.timestamp)} [${logicalId}]`)} ${line.message}`,
              }));
            })
            .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

          for (const entry of merged) {
            yield* Console.log(entry.formatted);
          }
        }).pipe(Effect.provide(stack.services));
      }).pipe(Effect.provide(services));
    }),
  ),
).pipe(Command.withDescription("Fetch or follow logs from stack resources"));
