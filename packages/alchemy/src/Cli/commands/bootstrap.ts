import * as Auth from "@distilled.cloud/aws/Auth";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import type { FileSystem } from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { Path } from "effect/Path";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import type { HttpClient } from "effect/unstable/http/HttpClient";

import {
  bootstrap as bootstrapAws,
  destroyBootstrap as destroyBootstrapAws,
} from "../../AWS/Bootstrap";
import * as AWSCredentials from "../../AWS/Credentials";
import * as AWSEnvironment from "../../AWS/Environment";
import * as AWSRegion from "../../AWS/Region";
import { AuthProviders } from "../../Auth/AuthProvider";
import { withProfileOverride } from "../../Auth/Profile";
import * as CloudflareAccess from "../../Cloudflare/Access.ts";
import { CloudflareAuth } from "../../Cloudflare/Auth/AuthProvider";
import * as CloudflareEnvironment from "../../Cloudflare/CloudflareEnvironment";
import * as CloudflareCredentials from "../../Cloudflare/Credentials";
import { bootstrap as bootstrapCloudflare } from "../../Cloudflare/StateStore/State";
import { loadConfigProvider } from "../../Util/ConfigProvider";
import { fileLogger } from "../../Util/FileLogger";

import { envFile, instrumentCommand, profile } from "./_shared.ts";

const awsProfile = Flag.string("profile").pipe(
  Flag.withDescription("AWS profile to use for credentials"),
  Flag.optional,
  Flag.map(Option.getOrElse(() => "default")),
);

const awsRegion = Flag.string("region").pipe(
  Flag.withDescription(
    "AWS region to bootstrap (defaults to AWS_REGION env var)",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

const bootstrapDestroy = Flag.boolean("destroy").pipe(
  Flag.withDescription("Destroy all bootstrap buckets in the selected region"),
  Flag.withDefault(false),
);

const bootstrapAwsCommand = Command.make(
  "aws",
  {
    envFile,
    profile: awsProfile,
    region: awsRegion,
    destroy: bootstrapDestroy,
  },
  instrumentCommand(
    "bootstrap.aws",
    (a: { profile: string; region: string | undefined; destroy: boolean }) => ({
      "alchemy.profile": a.profile,
      "alchemy.region": a.region ?? "",
      "alchemy.destroy": a.destroy,
    }),
  )(
    Effect.fnUntraced(function* ({ envFile, profile, region, destroy }) {
      const logger = Logger.layer([fileLogger("bootstrap.txt")], {
        mergeWithExisting: true,
      });

      return yield* Effect.gen(function* () {
        const ssoProfile = yield* Auth.loadProfile(profile);
        if (!ssoProfile.sso_account_id) {
          return yield* Effect.die(
            `AWS SSO profile '${profile}' is missing sso_account_id`,
          );
        }

        // Build a single AWSEnvironment, then derive Region/Credentials from
        // it so resource providers downstream see a consistent view. The
        // credentials Effect captures FileSystem/Path/HttpClient via the
        // ambient context; AWSEnvironment expects R=never, so we provide it
        // here.
        const ambient = yield* Effect.context<FileSystem | Path | HttpClient>();
        const environment = AWSEnvironment.makeEnvironment({
          accountId: ssoProfile.sso_account_id,
          region: region ?? ssoProfile.region ?? "us-east-1",
          credentials: Auth.loadProfileCredentials(profile).pipe(
            Effect.provide(ambient),
          ),
          profile,
        });

        const awsLayers = Layer.provideMerge(
          Layer.mergeAll(
            AWSRegion.fromEnvironment,
            AWSCredentials.fromEnvironment,
          ),
          environment,
        );

        return yield* Effect.gen(function* () {
          const provider = yield* loadConfigProvider(envFile);
          const bootstrapLayer = Layer.provide(
            awsLayers,
            Layer.succeed(ConfigProvider.ConfigProvider, provider),
          );
          if (destroy) {
            yield* destroyBootstrapAws().pipe(
              Effect.tap((result) =>
                result.destroyed === 0
                  ? Console.log("✓ No bootstrap buckets found to destroy")
                  : Console.log(
                      `✓ Destroyed ${result.destroyed} bootstrap bucket(s): ${result.bucketNames.join(", ")}`,
                    ),
              ),
              Effect.provide(bootstrapLayer),
            );
            return;
          }
          yield* bootstrapAws().pipe(
            Effect.tap(({ bucketName, created }) =>
              created
                ? Console.log(`✓ Created assets bucket: ${bucketName}`)
                : Console.log(`✓ Assets bucket already exists: ${bucketName}`),
            ),
            Effect.provide(bootstrapLayer),
          );
        });
      }).pipe(Effect.provide(logger));
    }),
  ),
);

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

const bootstrapCloudflareCommand = Command.make(
  "cloudflare",
  {
    envFile,
    profile,
    force: cloudflareForce,
    workerName: cloudflareWorkerName,
  },
  instrumentCommand(
    "bootstrap.cloudflare",
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
      const logger = Logger.layer([fileLogger("bootstrap.txt")], {
        mergeWithExisting: true,
      });

      // Wire up the same Cloudflare auth chain that
      // `Cloudflare.state(...)` uses internally. CloudflareAuth is an
      // `effectDiscard` layer that registers itself into the
      // `AuthProviders` registry at build time, and downstream layers
      // (`fromProfile`, `fromAuthProvider`) plus the deploy stack all
      // look the registry back up through `getAuthProvider`. We need
      // the registry to remain visible all the way through, so the
      // composition uses `provideMerge` (provides + re-exports) rather
      // than `provide` (provides + hides).
      const authProviders: AuthProviders["Service"] = {};
      const authRegistry = Layer.succeed(AuthProviders, authProviders);
      const authLayer = Layer.provideMerge(CloudflareAuth, authRegistry);
      const cloudflareLayers = Layer.provideMerge(
        Layer.mergeAll(
          CloudflareCredentials.fromAuthProvider(),
          CloudflareEnvironment.fromProfile(),
          CloudflareAccess.AccessLive,
        ),
        authLayer,
      );

      const services = Layer.mergeAll(
        cloudflareLayers,
        ConfigProvider.layer(
          withProfileOverride(yield* loadConfigProvider(envFile), profile),
        ),
        logger,
      );

      yield* bootstrapCloudflare({ workerName, force }).pipe(
        Effect.provide(services),
      );
    }),
  ),
);

export const bootstrapCommand = Command.make("bootstrap", {}).pipe(
  Command.withSubcommands([bootstrapAwsCommand, bootstrapCloudflareCommand]),
);
