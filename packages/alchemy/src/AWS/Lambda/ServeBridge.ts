/**
 * The AWS (Lambda / Node) recipe of the `alchemy/Serve` runtime bridge —
 * the cloud-specific half of `Serve/Bridge.ts`'s {@link makeBridgeCore}.
 * Stamped on AWS Website/Function classes under `SERVE_BRIDGE_KEY` at
 * class construction, it is the runtime half the user's `mount(Site)`
 * dispatches matched requests to (Serve/DESIGN.md — the mount is user
 * source; this bridge only ever answers `site.fetch(request)`).
 *
 * The recipe carries what is genuinely AWS: the credentials ladder
 * (`Credentials.fromChain()` resolves the Lambda execution-role env AND
 * the developer's ambient profile under `alchemy dev`, where the framework
 * dev server runs this bridge in a plain Node process — or the local floci
 * emulator identity when `ALCHEMY_AWS_ENDPOINT_URL` opts in), the Node
 * platform, the streamify-safe request pipeline, and the internal Lambda
 * extension that buys the SIGTERM Shutdown window. Everything delicate —
 * memoized builds, healing, request scopes, settle — lives once, in the
 * shared core. `waitUntil` never applies here: no mount forwards one, so
 * request scopes settle inline before the response (Lambda semantics).
 */

import { Endpoint } from "@distilled.cloud/aws";
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Region from "@distilled.cloud/aws/Region";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
  makeBridgeCore,
  type BridgeRecipe,
  type SiteRuntime,
} from "../../Serve/Bridge.ts";
import { SERVE_BRIDGE_KEY } from "../../Serve/constants.ts";
import { envString } from "../../Serve/Env.ts";
import { registerEntrypointExtension } from "./EntryRuntime.ts";
import { makeFunctionFetchHandler } from "./HttpServer.ts";

const recipe: BridgeRecipe = {
  // Env: the explicit override from the mount, else `process.env` — the
  // Lambda sandbox env (packed markers via collect-only mode) or the
  // dev-server process env `alchemy dev` lowered the same values into.
  resolveEnv: (explicit) =>
    (explicit as Record<string, unknown> | undefined) ??
    (typeof process !== "undefined"
      ? (process.env as Record<string, unknown>)
      : undefined),

  layers: (env) =>
    // Cloud access ladder:
    //  - default: `fromChain()` resolves the Lambda execution-role env
    //    credentials in the sandbox AND the developer's ambient profile
    //    (SSO, ini) when the framework dev server runs this bridge in
    //    plain Node under `alchemy dev` — the AWS dev model: bindings hit
    //    real cloud (capability resources are typically `Alchemy.remote()`
    //    in dev).
    //  - `ALCHEMY_AWS_ENDPOINT_URL` set (opt-in, e.g. via
    //    `server.environment`): capability clients target that local
    //    emulator gateway with the emulator's fixed dummy identity —
    //    mirroring `makeFlociServices` — for sites whose resources live in
    //    the floci emulator. Scoped to this bridge only (a dedicated env
    //    name, never `AWS_*`) so the developer's ambient credentials stay
    //    untouched for their own code in the same dev-server process.
    ((): Layer.Layer<Credentials.Credentials | Region.Region> => {
      const localEndpoint = envString(env.ALCHEMY_AWS_ENDPOINT_URL);
      if (localEndpoint === undefined) {
        return Layer.mergeAll(Credentials.fromChain(), Region.fromEnv());
      }
      const region = "us-east-1" as Region.RegionName;
      return Layer.mergeAll(
        Layer.succeed(Endpoint.Endpoint, Effect.succeed(localEndpoint)),
        Layer.succeed(Region.Region, Effect.succeed(region)),
        Layer.succeed(
          Credentials.Credentials,
          Effect.succeed({
            accessKeyId: Redacted.make("test"),
            secretAccessKey: Redacted.make("test"),
            sessionToken: undefined,
            region,
          }),
        ),
      );
    })(),

  platform: () =>
    Layer.mergeAll(
      NodeServices.layer,
      FetchHttpClient.layer,
      Logger.layer([Logger.consolePretty()]),
    ),

  requestEffect: (request, handler) =>
    makeFunctionFetchHandler(handler)(request),

  // Register before the first layer build so the Shutdown window exists by
  // the time any init-level finalizer is registered (shared memo with the
  // plain-entry runtime, so a framework composite registers it once).
  init: () => registerEntrypointExtension(),
};

const core = makeBridgeCore(recipe);

/**
 * The class-carried serve bridge for AWS-hosted Website classes (attached
 * under `SERVE_BRIDGE_KEY` by the effectful AWS Website constructs at
 * class construction). `Serve.toHandler` — and therefore the framework mounts
 * `toHandler` (Next.js) and `toHandler` (Nuxt/nitro) —
 * dispatches matched requests here, so the layer recipe carries
 * `Credentials.fromChain()` / `Region.fromEnv()` for SDK-backed capability
 * clients. Its `runtime` seam hands the value-form `createClient` the
 * Lambda/Node-flavored instance runtime (same per-class memo as the fetch
 * path).
 *
 * `Serve.toHandler` owns the `server.routes` gate and only dispatches requests
 * inside the claim — no second gate here.
 */
export const lambdaServeBridge = {
  match: (
    site: object,
    request: Request,
    options?: { env?: unknown },
  ): Promise<Response | undefined> =>
    core.match(site, request, { env: options?.env }),
  dispose: (site: object): Promise<void> => core.dispose(site),
  runtime: (site: object, env: Record<string, unknown>): Promise<SiteRuntime> =>
    core.getRuntime(site, env),
  /** Stamp this bridge on a Website class (the AWS construct class arms). */
  attach: <T>(cls: T): T =>
    Object.assign(cls as object, {
      [SERVE_BRIDGE_KEY]: lambdaServeBridge,
    }) as T,
};
