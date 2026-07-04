/**
 * One-off: resolve the Cloudflare State layer with `updateStateStore: true`
 * so an out-of-date deployed state-store worker is upgraded in place to the
 * current STATE_STORE_VERSION. Usage:
 *
 *   ALCHEMY_PROFILE=testing bun scripts/upgrade-cf-state-store.ts
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { AlchemyContext } from "../src/AlchemyContext.ts";
import { AuthProviders } from "../src/Auth/AuthProvider.ts";
import { CredentialsStoreLive } from "../src/Auth/Credentials.ts";
import { ProfileLive } from "../src/Auth/Profile.ts";
import { LoggingCli } from "../src/Cli/LoggingCli.ts";
import * as Cloudflare from "../src/Cloudflare/index.ts";
import { State } from "../src/State/State.ts";
import { PlatformServices } from "../src/Util/PlatformServices.ts";

const platformLayer = Layer.mergeAll(
  PlatformServices,
  FetchHttpClient.layer,
  Layer.provide(ProfileLive, PlatformServices),
  Layer.provide(CredentialsStoreLive, PlatformServices),
);

const AutoUpgradeContext = Layer.effect(
  AlchemyContext,
  Effect.sync(() => ({
    dotAlchemy: `${process.cwd()}/.alchemy`,
    dev: false,
    adopt: false,
    updateStateStore: true,
  })),
);

const main = Effect.gen(function* () {
  const state = yield* yield* State;
  const version = yield* state.getVersion();
  yield* Effect.log(`state store serving at v${version}`);
}).pipe(
  Effect.provide(Cloudflare.state()),
  Effect.provideService(AuthProviders, {}),
  Effect.provide(
    Layer.provideMerge(
      Layer.mergeAll(LoggingCli, AutoUpgradeContext),
      platformLayer,
    ),
  ),
);

Effect.runPromise(main as Effect.Effect<void>).then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
