import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import { cloudflareCliDependencyGroup } from "../../ProviderDependencies.ts";
import { envFile, instrumentCommand, profile } from "./_shared.ts";
import { makeProviderCommandLoadError } from "./ProviderCommandLoadError.ts";

const loadCloudflareCommands = Effect.tryPromise({
  try: () => import("./cloudflare.ts"),
  catch: (cause) =>
    makeProviderCommandLoadError({
      command: "alchemy cloudflare",
      group: cloudflareCliDependencyGroup,
      cause,
    }),
});

const cloudflareForce = Flag.boolean("force").pipe(
  Flag.withDescription(
    "Force a full redeploy even if the state-store worker already exists. " +
      "Without this flag, an existing worker is adopted and only its credentials are refreshed.",
  ),
  Flag.withDefault(false),
);

const cloudflareWorkerName = Flag.string("worker-name").pipe(
  Flag.withDescription(
    "Override the default state-store worker name (advanced; only needed for multiple state stores per account).",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

const tailFlag = Flag.boolean("tail").pipe(
  Flag.withDescription(
    "Stream logs in real time via the Cloudflare tail websocket instead of fetching past entries.",
  ),
  Flag.withDefault(false),
);

const limitFlag = Flag.integer("limit").pipe(
  Flag.withDescription("Number of log entries to fetch (ignored with --tail)"),
  Flag.withDefault(100),
);

const sinceFlag = Flag.string("since").pipe(
  Flag.withDescription(
    "Fetch logs since this time (e.g. '1h', '30m', '2024-01-01T00:00:00Z')",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

const bootstrapCommand = Command.make(
  "bootstrap",
  {
    envFile,
    profile,
    force: cloudflareForce,
    workerName: cloudflareWorkerName,
  },
  instrumentCommand(
    "cloudflare.bootstrap",
    (a: {
      profile: string;
      force: boolean;
      workerName: string | undefined;
    }) => ({
      "alchemy.profile": a.profile,
      "alchemy.force": a.force,
      "alchemy.worker_name": a.workerName ?? "",
    }),
  )(
    Effect.fnUntraced(function* (input) {
      const commands = yield* loadCloudflareCommands;
      yield* commands.runCloudflareBootstrap(input);
    }),
  ),
);

const stateLogsCommand = Command.make(
  "logs",
  {
    envFile,
    profile,
    workerName: cloudflareWorkerName,
    tail: tailFlag,
    limit: limitFlag,
    since: sinceFlag,
  },
  instrumentCommand(
    "cloudflare.state.logs",
    (a: {
      profile: string;
      workerName: string | undefined;
      tail: boolean;
      limit: number;
    }) => ({
      "alchemy.profile": a.profile,
      "alchemy.worker_name": a.workerName ?? "alchemy-state-store",
      "alchemy.tail": a.tail,
      "alchemy.limit": a.limit,
    }),
  )(
    Effect.fnUntraced(function* (input) {
      const commands = yield* loadCloudflareCommands;
      yield* commands.runCloudflareStateLogs(input);
    }),
  ),
);

const stateCommand = Command.make("state", {}).pipe(
  Command.withSubcommands([stateLogsCommand]),
);

export const cloudflareCommand = Command.make("cloudflare", {}).pipe(
  Command.withSubcommands([bootstrapCommand, stateCommand]),
);
