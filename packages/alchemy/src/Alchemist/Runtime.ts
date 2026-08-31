import * as ConfigProvider from "effect/ConfigProvider";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { AlchemyContextLive } from "../AlchemyContext.ts";
import { ArtifactStore, createArtifactStore } from "../Artifacts.ts";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileStoreLive } from "../Auth/Profile.ts";
import * as CliKit from "../Cli/CliKit/index.ts";
import { PlatformServices } from "../Util/PlatformServices.ts";
import { routeCacheLayer } from "./Session.ts";

/**
 * All services required by the programmatic Alchemist API.
 *
 * Progress reporting remains caller-controlled: without an override the
 * default reporter is a no-op, while interactive and plain renderers can
 * provide {@link import("./Progress.ts").Progress} around individual calls.
 * CliKit is installed without input for the engine paths that still depend on
 * it; those paths should eventually move to presentation-free services.
 *
 * @example
 * ```ts
 * Effect.runPromise(
 *   program.pipe(Effect.provide(Alchemist.layer()), Effect.scoped),
 * )
 * ```
 */
export const layer = () =>
  Layer.mergeAll(
    Layer.mergeAll(
      AlchemyContextLive,
      ProfileStoreLive,
      CredentialsStoreLive,
    ).pipe(Layer.provideMerge(PlatformServices)),
    FetchHttpClient.layer,
    ConfigProvider.layer(ConfigProvider.fromEnv()),
    Layer.succeed(ArtifactStore, createArtifactStore()),
    routeCacheLayer,
    CliKit.layer({ input: false }),
  );
