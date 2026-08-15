import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";

import { AuthProviders } from "../../Auth/AuthProvider.ts";
import { withProfileOverride } from "../../Auth/Profile.ts";
import { VercelAuth } from "../../Vercel/AuthProvider.ts";
import * as VercelCredentials from "../../Vercel/Credentials.ts";
import {
  bootstrap as bootstrapVercel,
  teardownStateStore,
} from "../../Vercel/StateStore/State.ts";
import * as VercelEnvironment from "../../Vercel/VercelEnvironment.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { fileLogger } from "../../Util/FileLogger.ts";

import { envFile, instrumentCommand, profile } from "./_shared.ts";

/**
 * Build the Vercel auth + environment layer stack used by every
 * `alchemy vercel ...` subcommand. Mirrors the wiring inside
 * `Vercel.state(...)` so the command can talk to the user's team
 * out-of-band.
 */
const vercelLayers = (envFileOpt: Option.Option<string>, profileName: string) =>
  Effect.gen(function* () {
    const authProviders: AuthProviders["Service"] = {};
    const authRegistry = Layer.succeed(AuthProviders, authProviders);
    const authLayer = Layer.provideMerge(VercelAuth, authRegistry);
    const vercel = Layer.provideMerge(
      Layer.mergeAll(
        VercelCredentials.fromAuthProvider(),
        VercelEnvironment.fromProfile(),
      ),
      authLayer,
    );

    const logger = Logger.layer([fileLogger("vercel.txt")], {
      mergeWithExisting: true,
    });

    return Layer.mergeAll(
      vercel,
      ConfigProvider.layer(
        withProfileOverride(yield* loadConfigProvider(envFileOpt), profileName),
      ),
      logger,
    );
  });

const vercelForce = Flag.boolean("force").pipe(
  Flag.withDescription(
    "Force a full redeploy even if the state-store project already exists. " +
      "Without this flag, an existing store is adopted and only its credentials are refreshed.",
  ),
  Flag.withDefault(false),
);

const vercelProjectName = Flag.string("project-name").pipe(
  Flag.withDescription(
    "Override the default state-store project name (advanced; also set " +
      "ALCHEMY_VERCEL_STATE_PROJECT so the deployed function agrees).",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

const bootstrapCommand = Command.make(
  "bootstrap",
  {
    envFile,
    profile,
    force: vercelForce,
    projectName: vercelProjectName,
  },
  instrumentCommand(
    "vercel.bootstrap",
    (a: {
      profile: string;
      force: boolean;
      projectName: string | undefined;
    }) => ({
      "alchemy.profile": a.profile,
      "alchemy.force": a.force,
      "alchemy.project_name": a.projectName ?? "",
    }),
  )(
    Effect.fn(function* ({ envFile, profile, force, projectName }) {
      const services = yield* vercelLayers(envFile, profile);
      yield* bootstrapVercel({
        projectName,
        force,
        profile,
      }).pipe(Effect.provide(services));
    }),
  ),
).pipe(
  Command.withDescription(
    "Deploy (or upgrade) the Vercel state store used by Vercel.state()",
  ),
);

const teardownCommand = Command.make(
  "teardown",
  {
    envFile,
    profile,
    projectName: vercelProjectName,
  },
  instrumentCommand(
    "vercel.teardown",
    (a: { profile: string; projectName: string | undefined }) => ({
      "alchemy.profile": a.profile,
      "alchemy.project_name": a.projectName ?? "",
    }),
  )(
    Effect.fn(function* ({ envFile, profile, projectName }) {
      const services = yield* vercelLayers(envFile, profile);
      yield* teardownStateStore({
        projectName,
        profile,
      }).pipe(Effect.provide(services));
    }),
  ),
).pipe(
  Command.unlisted,
  Command.withDescription("Tear down the Vercel state store"),
);

export const vercelCommand = Command.make("vercel", {}).pipe(
  Command.withSubcommands([bootstrapCommand, teardownCommand]),
);
