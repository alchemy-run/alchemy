import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/unstable/cli";

import type {
  AuthProvider,
  EnvironmentVariable,
} from "../../Auth/AuthProvider.ts";
import { getEnv } from "../../Auth/Env.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { resolveProfileName } from "../ProfileSelection.ts";
import { CliKit } from "../CliKit/CliKit.ts";
import { collectAuthProviders } from "./profile/flows.ts";

import { awsCommand } from "./aws.ts";
import { cloudflareCommand } from "./cloudflare.ts";
import {
  config,
  envFile,
  instrumentCommand,
  UserInputError,
} from "./_shared.ts";

const providerFilter = Flag.string("provider").pipe(
  Flag.withDescription(
    "Check only this provider (repeatable; defaults to every provider the stack registers)",
  ),
  Flag.atLeast(0),
);

/**
 * `true` when the variable's requirement is satisfied: its name or any
 * declared alternative resolves to a non-empty value.
 */
const isSatisfied = (variable: EnvironmentVariable) =>
  Effect.gen(function* () {
    for (const name of [variable.name, ...(variable.alternatives ?? [])]) {
      const value = yield* getEnv(name);
      if (value !== undefined && value.length > 0) return true;
    }
    return false;
  });

const checkEnvCommand = Command.make(
  "check-env",
  { provider: providerFilter, main: config, envFile },
  instrumentCommand("provider.check-env")(
    Effect.fn(function* ({ provider: requested, main, envFile }) {
      const cli = yield* CliKit;
      // Built-in providers plus the stack's own providers() registrations
      // (which override built-ins by name); a missing conventional
      // entrypoint just leaves the built-ins.
      const profile = yield* resolveProfileName(envFile, undefined);
      const all = yield* collectAuthProviders({ main, envFile, profile });
      let registry: Record<string, AuthProvider> = all;
      if (requested.length > 0) {
        registry = {};
        for (const input of requested) {
          const name = Object.keys(all).find(
            (candidate) => candidate.toLowerCase() === input.toLowerCase(),
          );
          if (name === undefined) {
            return yield* Effect.fail(
              new UserInputError({
                message: `Unknown provider '${input}'. Registered: ${Object.keys(all).sort().join(", ")}.`,
              }),
            );
          }
          registry[name] = all[name]!;
        }
      }

      // Resolve variables against the process env merged with --env-file,
      // exactly as credential resolution would see them.
      const configProvider = yield* loadConfigProvider(envFile);
      yield* Effect.gen(function* () {
        const names = Object.keys(registry).sort();
        let failed = false;
        for (const name of names) {
          const environment = registry[name]!.environment;
          if (environment.length === 0) {
            yield* cli.output.info({
              message: name,
              detail: "No CI environment contract",
            });
            continue;
          }
          const missing: string[] = [];
          for (const variable of environment) {
            if (variable.required && !(yield* isSatisfied(variable))) {
              missing.push(
                [variable.name, ...(variable.alternatives ?? [])].join(" | "),
              );
            }
          }
          if (missing.length === 0) {
            yield* cli.output.success(name);
          } else {
            failed = true;
            yield* cli.output.error({
              message: name,
              detail: `Missing: ${missing.join(", ")}`,
            });
          }
        }
        if (failed) {
          yield* Effect.sync(() => {
            process.exitCode = 1;
          });
        }
      }).pipe(Effect.provide(ConfigProvider.layer(configProvider)));
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
