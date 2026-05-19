import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import { dependencyGroups } from "../../ProviderDependencies.ts";
import { envFile, instrumentCommand } from "./_shared.ts";
import { makeProviderCommandLoadError } from "./ProviderCommandLoadError.ts";

const loadAwsCommands = Effect.tryPromise({
  try: () => import("./aws.ts"),
  catch: (cause) =>
    makeProviderCommandLoadError({
      command: "alchemy aws",
      group: dependencyGroups.aws,
      cause,
    }),
});

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

const bootstrapCommand = Command.make(
  "bootstrap",
  {
    envFile,
    profile: awsProfile,
    region: awsRegion,
    destroy: bootstrapDestroy,
  },
  instrumentCommand(
    "aws.bootstrap",
    (a: { profile: string; region: string | undefined; destroy: boolean }) => ({
      "alchemy.profile": a.profile,
      "alchemy.region": a.region ?? "",
      "alchemy.destroy": a.destroy,
    }),
  )(
    Effect.fnUntraced(function* (input) {
      const commands = yield* loadAwsCommands;
      yield* commands.runAwsBootstrap(input);
    }),
  ),
);

export const awsCommand = Command.make("aws", {}).pipe(
  Command.withSubcommands([bootstrapCommand]),
);
