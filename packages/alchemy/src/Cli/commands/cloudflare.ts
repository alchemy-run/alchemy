import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

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

import { formatLocalTimestamp, parseSince } from "./_shared.ts";

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

export const runCloudflareBootstrap = Effect.fnUntraced(function* ({
  envFile,
  profile,
  force,
  workerName,
}: {
  envFile: Option.Option<string>;
  profile: string;
  force: boolean;
  workerName: string | undefined;
}) {
  const services = yield* cloudflareLayers(envFile, profile);
  yield* bootstrapCloudflare({ workerName, force }).pipe(
    Effect.provide(services),
  );
});

/**
 * `alchemy cloudflare state logs` — get or tail logs from the
 * `alchemy-state-store` Worker on the user's account. Lets us debug
 * the state-store worker without standing up a stack file.
 */
export const runCloudflareStateLogs = Effect.fnUntraced(function* ({
  envFile,
  profile,
  workerName,
  tail,
  limit,
  since,
}: {
  envFile: Option.Option<string>;
  profile: string;
  workerName: string | undefined;
  tail: boolean;
  limit: number;
  since: string | undefined;
}) {
  const services = yield* cloudflareLayers(envFile, profile);
  const scriptName = workerName ?? STATE_STORE_SCRIPT_NAME;

  yield* Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment.CloudflareEnvironment;
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
});
