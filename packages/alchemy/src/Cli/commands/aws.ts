import * as Auth from "@distilled.cloud/aws/Auth";
import * as ConfigProvider from "effect/ConfigProvider";
import * as CliKit from "../CliKit/index.ts";
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
} from "../../AWS/Bootstrap.ts";
import * as AWSCredentials from "../../AWS/Credentials.ts";
import { AWSEnvironment } from "../../AWS/Environment.ts";
import * as AWSRegion from "../../AWS/Region.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { fileLogger } from "../../Util/FileLogger.ts";

import { envFile, instrumentCommand, yes } from "./_shared.ts";

const awsProfile = Flag.string("aws-profile").pipe(
  Flag.withDescription("AWS CLI/SSO profile to use for bootstrap credentials"),
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

const runBootstrap = Effect.fn(function* (args: {
  envFile: Option.Option<string>;
  profile: string;
  region: string | undefined;
  destroy: boolean;
}) {
  const { envFile, profile, region, destroy } = args;
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
    const environment = Layer.succeed(
      AWSEnvironment,
      Effect.succeed({
        accountId: ssoProfile.sso_account_id,
        region: region ?? ssoProfile.region ?? "us-east-1",
        credentials: Auth.loadProfileCredentials(profile).pipe(
          Effect.provide(ambient),
        ),
        profile,
      }),
    );
    const awsLayers = Layer.provideMerge(
      Layer.mergeAll(AWSRegion.fromEnvironment, AWSCredentials.fromEnvironment),
      environment,
    );

    const prompt = yield* CliKit.CliKit;
    const provider = yield* loadConfigProvider(envFile);
    const bootstrapLayer = Layer.provide(
      awsLayers,
      Layer.succeed(ConfigProvider.ConfigProvider, provider),
    );
    if (destroy) {
      yield* destroyBootstrapAws().pipe(
        Effect.tap((result) =>
          result.destroyed === 0
            ? prompt.output.success("No bootstrap buckets found to destroy")
            : prompt.output.success(
                `Destroyed ${result.destroyed} bootstrap bucket(s): ${result.bucketNames.join(", ")}`,
              ),
        ),
        Effect.provide(bootstrapLayer),
      );
      return;
    }
    yield* bootstrapAws().pipe(
      Effect.tap(({ bucketName, created }) =>
        created
          ? prompt.output.success(`Created assets bucket: ${bucketName}`)
          : prompt.output.success(
              `Assets bucket already exists: ${bucketName}`,
            ),
      ),
      Effect.provide(bootstrapLayer),
    );
  }).pipe(Effect.provide(logger));
});

const teardownCommand = Command.make(
  "teardown",
  { envFile, profile: awsProfile, region: awsRegion, yes },
  instrumentCommand(
    "provider.aws.teardown",
    (a: { profile: string; region: string | undefined }) => ({
      "aws.profile": a.profile,
      "alchemy.region": a.region ?? "",
    }),
  )(
    Effect.fn(function* ({ yes: approved, ...args }) {
      if (
        !approved &&
        !(yield* (yield* CliKit.CliKit).prompt.confirm({
          message: "Destroy every Alchemy bootstrap bucket in this AWS region?",
          initialValue: false,
        }))
      ) {
        return;
      }
      yield* runBootstrap({ ...args, destroy: true });
    }),
  ),
).pipe(Command.withDescription("Destroy the AWS deployment assets buckets"));

const bootstrapCommand = Command.make(
  "bootstrap",
  { envFile, profile: awsProfile, region: awsRegion },
  instrumentCommand(
    "provider.aws.bootstrap",
    (a: { profile: string; region: string | undefined }) => ({
      "aws.profile": a.profile,
      "alchemy.region": a.region ?? "",
    }),
  )(
    Effect.fn(function* (args) {
      yield* runBootstrap({ ...args, destroy: false });
    }),
  ),
).pipe(Command.withDescription("Provision the AWS deployment assets bucket"));

export const awsCommand = Command.make("aws", {}).pipe(
  Command.withDescription("Manage AWS provider prerequisites"),
  Command.withSubcommands([bootstrapCommand, teardownCommand]),
);
