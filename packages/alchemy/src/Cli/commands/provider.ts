import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";

import { ProviderControl } from "../../AlchemyControl/ProviderControl.ts";
import { resolveProfileName } from "../ProfileSelection.ts";
import { CliKit } from "../CliKit/CliKit.ts";

import { awsCommand } from "./aws.ts";
import { cloudflareCommand } from "./cloudflare.ts";
import {
  config,
  envFile,
  instrumentCommand,
  profile,
  setExitCode,
} from "./_shared.ts";

/** Optional repeatable filter for checking a subset of registered providers. */
const checkedProviders = Flag.string("provider").pipe(
  Flag.withDescription(
    "Check only this provider (repeatable; defaults to every provider the stack registers)",
  ),
  Flag.atLeast(0),
);

const checkEnvCommand = Command.make(
  "check-env",
  { provider: checkedProviders, main: config, envFile, profile },
  instrumentCommand("provider.check-env")(
    Effect.fn(function* ({ provider: requested, main, envFile, profile }) {
      const cli = yield* CliKit;
      const profileName = yield* resolveProfileName(envFile, profile);
      const result = yield* (yield* ProviderControl).checkEnvironment({
        entrypoint: main,
        envFile: Option.getOrUndefined(envFile),
        profile: profileName,
        providers: requested,
      });
      for (const check of result.checks) {
        if (check.status === "no-contract") {
          yield* cli.output.info({
            message: check.provider,
            detail: "No CI environment contract",
          });
        } else if (check.status === "satisfied") {
          yield* cli.output.success(check.provider);
        } else {
          yield* cli.output.error({
            message: check.provider,
            detail: `Missing: ${check.missing
              .map(({ alternatives }) => alternatives.join(" | "))
              .join(", ")}`,
          });
        }
      }
      if (!result.satisfied) yield* setExitCode(1);
    }),
  ),
).pipe(
  Command.withDescription(
    "Verify the required environment variables for the stack's providers are set (CI preflight; exits 1 when any are missing)",
  ),
);

export const providerCommand = Command.make("provider", {}).pipe(
  Command.withDescription("Manage cloud provider prerequisites and utilities"),
  Command.withSubcommands([checkEnvCommand, awsCommand, cloudflareCommand]),
);
