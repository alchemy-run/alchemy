import * as CliKit from "../CliKit/index.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import { AwsControl } from "../../AlchemyControl/AwsControl.ts";

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
  const aws = yield* AwsControl;
  const prompt = yield* CliKit.CliKit;
  const target = {
    profile,
    region,
    envFile: Option.getOrUndefined(envFile),
  };
  if (destroy) {
    const result = yield* aws.teardown(target);
    yield* result.destroyed.length === 0
      ? prompt.output.success("No bootstrap buckets found to destroy")
      : prompt.output.success(
          `Destroyed ${result.destroyed.length} bootstrap bucket(s): ${result.destroyed.join(", ")}`,
        );
    return;
  }
  const result = yield* aws.bootstrap(target);
  yield* result.created
    ? prompt.output.success(`Created assets bucket: ${result.bucketName}`)
    : prompt.output.success(
        `Assets bucket already exists: ${result.bucketName}`,
      );
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
        !(yield* CliKit.accessors.prompt.confirm({
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
