import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";

import { LogControl } from "../../AlchemyControl/LogControl.ts";
import { paint } from "../CliKit/index.ts";
import {
  envFile,
  formatLocalTimestamp,
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
      const logs = yield* LogControl;
      const sinceDate = since ? yield* parseSince(since) : undefined;
      const selected = (resources ?? "")
        .split(",")
        .map((resource) => resource.trim())
        .filter((resource) => resource.length > 0);
      const target = {
        entrypoint: main,
        stage,
        profile,
        envFile: Option.getOrUndefined(envFile),
      };
      const available = yield* logs.resources(target);
      const selectedSet = new Set(selected);
      const matching = available.filter(
        (resource) =>
          selectedSet.size === 0 || selectedSet.has(resource.logicalId),
      );
      const colors = new Map(
        matching.map((resource, index) => [
          resource.logicalId,
          TAIL_COLORS[index % TAIL_COLORS.length]!,
        ]),
      );
      const format = (entry: {
        resource: { logicalId: string };
        timestamp: Date;
        message: string;
      }) =>
        `${paint(colors.get(entry.resource.logicalId) ?? "gray", `${formatLocalTimestamp(entry.timestamp)} [${entry.resource.logicalId}]`)} ${entry.message}`;

      if (follow) {
        const tailing = matching.filter((resource) => resource.supportsTail);
        if (tailing.length === 0) {
          yield* Console.log("No matching resources support live logs.");
          return;
        }
        yield* Console.log(
          `Following: ${tailing.map(({ logicalId }) => logicalId).join(", ")}`,
        );
        yield* logs
          .tail({ target, resources: selected })
          .pipe(Stream.runForEach((entry) => Console.log(format(entry))));
        return;
      }

      const entries = yield* logs.entries({
        target,
        resources: selected,
        limit,
        since: sinceDate,
      });
      if (entries.length === 0) {
        yield* Console.log(
          selected.length > 0
            ? "No resources with logs match --resource (deploy first, or selected resources may not expose logs)."
            : "No resources with logs found. Deploy first, then run logs.",
        );
        return;
      }
      for (const entry of entries) yield* Console.log(format(entry));
    }),
  ),
).pipe(Command.withDescription("Fetch or follow logs from stack resources"));
