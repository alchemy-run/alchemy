import type { NodeServices } from "@effect/platform-node/NodeServices";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type { HttpClient } from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import type { HttpServer } from "../Http.ts";
import { RuntimeConfigProviderLive } from "../Runtime.ts";
import { entrypointLayer, resolveProgram, runProcess, stackFromEnv } from "./Bootstrap.ts";

type ProcessServices = NodeServices | HttpClient | SecureRandom.SecureRandom;

export interface ContainerPlatformLayers<E = never> {
  readonly services: Layer.Layer<NodeServices, E>;
  readonly httpServer: Layer.Layer<HttpServer, E, ProcessServices>;
}

export type ContainerMode = "server" | "job";

export const bootstrap = <Identity, IdentityError, PlatformError>(
  entrypoint: unknown,
  platform: ContainerPlatformLayers<PlatformError>,
  mode: ContainerMode,
  identity?: Layer.Layer<Identity, IdentityError, ProcessServices>,
  label = mode === "server" ? "Container server" : "Container job",
): Promise<void> => {
  const services = Layer.mergeAll(
    platform.services,
    FetchHttpClient.layer,
    SecureRandom.layerWebCrypto,
    Logger.layer([Logger.consolePretty()]),
  );
  const entry = entrypointLayer(entrypoint).pipe(Layer.provideMerge(stackFromEnv));
  const workload = identity === undefined ? entry : entry.pipe(Layer.provideMerge(identity));
  const host =
    mode === "server" ? workload.pipe(Layer.provideMerge(platform.httpServer)) : workload;
  // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- the dynamically bundled entrypoint owns its Effect requirements and errors
  const program = resolveProgram("program").pipe(
    Effect.provide(
      host.pipe(Layer.provideMerge(services), Layer.provideMerge(RuntimeConfigProviderLive)),
    ),
    Effect.scoped,
  );
  // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- runProcess reports errors from the dynamically loaded entrypoint
  return runProcess(label, program, { exitOnComplete: mode === "job" });
};
