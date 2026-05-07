import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";

import { AuthProviders } from "../../Auth/AuthProvider.ts";
import { withProfileOverride } from "../../Auth/Profile.ts";
import * as CloudflareAccess from "../../Cloudflare/Access.ts";
import { CloudflareAuth } from "../../Cloudflare/Auth/AuthProvider.ts";
import * as CloudflareEnvironment from "../../Cloudflare/CloudflareEnvironment.ts";
import * as CloudflareCredentials from "../../Cloudflare/Credentials.ts";
import { CloudflareLogs } from "../../Cloudflare/Logs.ts";
import { STATE_STORE_SCRIPT_NAME } from "../../Cloudflare/StateStore/Api.ts";
import { bootstrap as bootstrapCloudflare } from "../../Cloudflare/StateStore/State.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { fileLogger } from "../../Util/FileLogger.ts";

import {
  envFile,
  formatLocalTimestamp,
  instrumentCommand,
  parseSince,
  profile,
} from "./_shared.ts";

/**
 * Build the Cloudflare auth + environment layer stack used by every
 * `alchemy cloudflare ...` subcommand. Mirrors the wiring inside
 * `Cloudflare.state(...)` so the command can talk to the user's
 * account out-of-band.
 */
const cloudflareLayers = (
  envFileOpt: Option.Option<string>,
  profileName: string,
) =>
  Effect.gen(function* () {
    const authProviders: AuthProviders["Service"] = {};
    const authRegistry = Layer.succeed(AuthProviders, authProviders);
    const authLayer = Layer.provideMerge(CloudflareAuth, authRegistry);
    const cf = Layer.provideMerge(
      Layer.mergeAll(
        CloudflareCredentials.fromAuthProvider(),
        CloudflareEnvironment.fromProfile(),
        CloudflareAccess.AccessLive,
      ),
      authLayer,
    );

    const logger = Logger.layer([fileLogger("cloudflare.txt")], {
      mergeWithExisting: true,
    });

    return Layer.mergeAll(
      cf,
      ConfigProvider.layer(
        withProfileOverride(yield* loadConfigProvider(envFileOpt), profileName),
      ),
      logger,
    );
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
    Effect.fnUntraced(function* ({ envFile, profile, force, workerName }) {
      const services = yield* cloudflareLayers(envFile, profile);
      yield* bootstrapCloudflare({ workerName, force }).pipe(
        Effect.provide(services),
      );
    }),
  ),
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

/**
 * `alchemy cloudflare state logs` — get or tail logs from the
 * `alchemy-state-store` Worker on the user's account. Lets us debug
 * the state-store worker without standing up a stack file.
 */
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
      "alchemy.worker_name": a.workerName ?? STATE_STORE_SCRIPT_NAME,
      "alchemy.tail": a.tail,
      "alchemy.limit": a.limit,
    }),
  )(
    Effect.fnUntraced(function* ({
      envFile,
      profile,
      workerName,
      tail,
      limit,
      since,
    }) {
      const services = yield* cloudflareLayers(envFile, profile);
      const scriptName = workerName ?? STATE_STORE_SCRIPT_NAME;

      yield* Effect.gen(function* () {
        const { accountId } =
          yield* CloudflareEnvironment.CloudflareEnvironment;
        const telemetry = yield* CloudflareLogs;

        const formatLine = (line: { timestamp: Date; message: string }) =>
          `${formatLocalTimestamp(line.timestamp)} [${scriptName}] ${line.message}`;

        if (tail) {
          yield* Console.log(`Tailing ${scriptName}...`);
          yield* telemetry
            .tailScript({ accountId, scriptName })
            .pipe(Stream.runForEach((line) => Console.log(formatLine(line))));
          return;
        }

        const sinceDate = since ? parseSince(since) : undefined;
        const lines = yield* telemetry.queryLogs({
          accountId,
          filters: [
            {
              key: "$workers.scriptName",
              operation: "eq",
              type: "string",
              value: scriptName,
            },
          ],
          options: { limit, since: sinceDate },
        });

        if (lines.length === 0) {
          yield* Console.log(`(no log entries for ${scriptName})`);
          return;
        }

        for (const line of lines.sort(
          (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
        )) {
          yield* Console.log(formatLine(line));
        }
      }).pipe(Effect.provide(services));
    }),
  ),
);

const stateCommand = Command.make("state", {}).pipe(
  Command.withSubcommands([stateLogsCommand]),
);

export const cloudflareCommand = Command.make("cloudflare", {}).pipe(
  Command.withSubcommands([bootstrapCommand, stateCommand]),
);
