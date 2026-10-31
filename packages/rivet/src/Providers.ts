import * as Provider from "alchemy/Provider";
import { Random, RandomProvider } from "alchemy/Random";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { Namespace, NamespaceProvider } from "./Namespace.ts";
import { Pool, PoolProvider } from "./Pool.ts";
import { Worker, WorkerProvider } from "./Worker.ts";

/** Service tag bundling every Rivet provider. */
export class Providers extends Provider.ProviderCollection<Providers>()("Rivet") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * The Rivet providers Layer. Each resource carries the endpoint and admin
 * token of the control plane it belongs to, so no credentials are configured
 * here.
 *
 * @example
 * ```ts
 * Alchemy.Stack("App", { providers: Layer.mergeAll(AWS.providers(), Rivet.providers()) }, ...)
 * ```
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([Namespace, Pool, Random, Worker])).pipe(
    Layer.provide(
      Layer.mergeAll(NamespaceProvider(), PoolProvider(), RandomProvider(), WorkerProvider()),
    ),
    Layer.provide(FetchHttpClient.layer),
  );
