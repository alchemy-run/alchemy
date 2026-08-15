import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import * as GlobalFlag from "effect/unstable/cli/GlobalFlag";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { ArtifactStore, createArtifactStore } from "alchemy/Artifacts";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import { TelemetryLive } from "alchemy/Telemetry/Layer";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import packageJson from "../../package.json" with { type: "json" };

import * as CliKit from "./CliKit/index.ts";
import { checkLatestVersion } from "./checkVersion.ts";
import { handleCliErrors } from "./commands/_shared.ts";
import { awsCommand } from "./commands/aws.ts";
import { cloudflareCommand } from "./commands/cloudflare.ts";
import {
  deployCommand,
  destroyCommand,
  planCommand,
} from "./commands/deploy.ts";
import { devCommand } from "./commands/dev.ts";
import { logsCommand } from "./commands/logs.ts";
import { unsafeCommand } from "./commands/nuke.ts";
import { profileCommand } from "./commands/profile/index.ts";
import { stateCommand } from "./commands/state.ts";
import { syncCommand } from "./commands/sync.ts";
import { tailCommand } from "./commands/tail.ts";
import { selectCli } from "./selectCli.ts";

/**
 * `--no-input` forces plain, prompt-free output regardless of TTY or env
 * detection. The value is read via an argv scan in `Util/interactive.ts`
 * (capability detection runs while the service layers are built, before flag
 * parsing); this registration exists so the parser accepts the flag and help
 * documents it.
 */
const NoInput = GlobalFlag.setting("no-input")({
  flag: Flag.boolean("no-input").pipe(
    Flag.withDescription(
      "Disable prompts and the interactive TUI (plain output; commands needing input fail)",
    ),
    Flag.withDefault(false),
  ),
});

const root = Command.make("alchemy", {}).pipe(
  Command.withSubcommands([
    awsCommand,
    cloudflareCommand,
    deployCommand,
    devCommand,
    destroyCommand,
    planCommand,
    tailCommand,
    logsCommand,
    profileCommand,
    stateCommand,
    syncCommand,
    unsafeCommand,
  ]),
  Command.withGlobalFlags([NoInput]),
);

const cli = Command.run(root, {
  // name: "Alchemy Effect CLI",
  version: packageJson.version,
});

const services = Layer.mergeAll(
  Layer.provideMerge(AlchemyContextLive, PlatformServices),
  Layer.provide(ProfileStoreLive, PlatformServices),
  Layer.provide(CredentialsStoreLive, PlatformServices),
  // Ambient per-CLI-run artifact root. Commands that define their own run
  // boundary (deploy, sync) provide a fresh store closer to the work, which
  // wins over this one.
  Layer.succeed(ArtifactStore, createArtifactStore()),
  FetchHttpClient.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
  TelemetryLive,
  // CliKit backs every prompt/screen surface (profile flows today; other
  // commands migrate off Clack in follow-up PRs). The ink renderer mounts
  // lazily, so plain runs never pay for it.
  Layer.provideMerge(selectCli(), CliKit.layer()),
);

const program = Effect.gen(function* () {
  // Best-effort check for a newer published version. Runs to completion
  // before the command so the warning prints before any interactive
  // prompts; the registry response is cached for a day and the fetch is
  // bounded by a short timeout, so this stays fast.
  yield* checkLatestVersion;
  return yield* cli;
});

export const main = program.pipe(
  // $USER and $STAGE are set by the environment
  Effect.provide(services),
  Effect.scoped,
  handleCliErrors,
);
