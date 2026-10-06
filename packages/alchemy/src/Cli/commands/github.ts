import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/cli";

import * as GitHub from "../../Alchemist/routes/github.ts";
import * as CliKit from "../CliKit/index.ts";
import { envFile, profile } from "./flags.ts";
import { instrumentCommand } from "./instrument.ts";

const baseUrl = Flag.String("base-url").pipe(
  Flag.withDescription(
    "GitHub host to sign in to (GitHub Enterprise Server). Defaults to github.com.",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

const browserLoginCommand = Command.make(
  "browser-login",
  { envFile, profile, baseUrl },
  instrumentCommand(
    "provider.github.browser-login",
    (a: { profile: string | undefined; baseUrl: string | undefined }) => ({
      "alchemy.profile": a.profile ?? "",
      "github.base_url": a.baseUrl ?? "",
    }),
  )(
    Effect.fn(function* ({ envFile, profile, baseUrl }) {
      const cli = yield* CliKit.CliKit;
      const result = yield* GitHub.browserLogin({
        profile,
        baseUrl,
        envFile: Option.getOrUndefined(envFile),
      });
      yield* cli.output.success({
        message: `Signed in as ${result.user}.`,
        detail: `Browser profile: ${result.profileDir}`,
      });
      yield* cli.output.info(
        "Use GitHub.providers({ browser: true }) to let deploys drive GitHub's web UI unattended.",
      );
    }),
  ),
).pipe(
  Command.withDescription(
    "Sign in to GitHub in a browser so deploys can drive its web UI unattended",
  ),
);

const browserLogoutCommand = Command.make(
  "browser-logout",
  { envFile, profile },
  instrumentCommand(
    "provider.github.browser-logout",
    (a: { profile: string | undefined }) => ({
      "alchemy.profile": a.profile ?? "",
    }),
  )(
    Effect.fn(function* ({ envFile, profile }) {
      const cli = yield* CliKit.CliKit;
      const result = yield* GitHub.browserLogout({
        profile,
        envFile: Option.getOrUndefined(envFile),
      });
      yield* result.removed
        ? cli.output.success(`Removed browser profile: ${result.profileDir}`)
        : cli.output.info(`No browser profile at ${result.profileDir}`);
    }),
  ),
).pipe(Command.withDescription("Delete the saved GitHub browser profile"));

export const githubCommand = Command.make("github", {}).pipe(
  Command.withDescription("Manage GitHub provider prerequisites"),
  Command.withSubcommands([browserLoginCommand, browserLogoutCommand]),
);
