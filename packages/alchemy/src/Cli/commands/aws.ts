import * as Auth from "@distilled.cloud/aws/Auth";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import type { FileSystem } from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { Path } from "effect/Path";
import type { HttpClient } from "effect/unstable/http/HttpClient";

import {
  bootstrap as bootstrapAws,
  destroyBootstrap as destroyBootstrapAws,
} from "../../AWS/Bootstrap.ts";
import * as AWSCredentials from "../../AWS/Credentials.ts";
import * as AWSEnvironment from "../../AWS/Environment.ts";
import * as AWSRegion from "../../AWS/Region.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { fileLogger } from "../../Util/FileLogger.ts";

export const runAwsBootstrap = Effect.fnUntraced(function* ({
  envFile,
  profile,
  region,
  destroy,
}: {
  envFile: Option.Option<string>;
  profile: string;
  region: string | undefined;
  destroy: boolean;
}) {
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
      Layer.mergeAll(AWSRegion.fromEnvironment, AWSCredentials.fromEnvironment),
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
});
