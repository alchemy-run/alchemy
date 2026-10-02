import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileStoreLive } from "../Auth/Profile.ts";
import * as Provider from "../Provider.ts";
import { AzureAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import * as Environment from "./Environment.ts";
import type { ServiceProviders } from "./ServiceProviders.ts";
// One import + one `services` entry per service, sorted. Each service owns
// its `<Service>/Providers.ts`; never list resources here.
import * as AuthorizationProviders from "./Authorization/Providers.ts";
import * as ManagedIdentityProviders from "./ManagedIdentity/Providers.ts";
import * as ResourcesProviders from "./Resources/Providers.ts";
import * as StorageProviders from "./Storage/Providers.ts";

const services: ReadonlyArray<ServiceProviders> = [
  AuthorizationProviders,
  ManagedIdentityProviders,
  ResourcesProviders,
  StorageProviders,
];

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Azure",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/** Auth, subscription environment, and HTTP client for every provider. */
const azureLive = Layer.mergeAll(
  Environment.environmentFromAuthProvider(),
  Credentials.fromAuthProvider(),
).pipe(
  Layer.provideMerge(AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

const makeProviders = () =>
  Layer.effect(
    Providers,
    Effect.gen(function* () {
      // Each service's collection is erased to its runtime shape: its
      // requirements (one Provider<X> per resource type) are satisfied by
      // the layers below, and inferring hundreds of them exhausts tsc.
      const merged: Record<string, any> = {};
      for (const service of services) {
        const collection = (yield* Provider.collection(
          service.resources as any[],
        ) as unknown as Effect.Effect<
          { providers: Record<string, any> },
          never,
          never
        >).providers;
        Object.assign(merged, collection);
      }
      return {
        kind: "ProviderCollection" as const,
        get: (type: string) => merged[type],
        providers: merged,
      };
    }),
  ).pipe(
    Layer.provide(
      (
        Layer.mergeAll as (
          ...layers: Layer.Layer<any, any, any>[]
        ) => Layer.Layer<any, any, any>
      )(...services.map((service) => service.layers())).pipe(
        Layer.provide(azureLive),
      ),
    ),
    Layer.provideMerge(azureLive),
    Layer.orDie,
    // Erased on purpose: the inferred union of hundreds of provider layers
    // exhausts the type-checker.
  ) as Layer.Layer<any, never, never>;

let cachedProviders: ReturnType<typeof makeProviders> | undefined;

/**
 * Build a layer that registers all Azure resource providers, the Azure
 * `AuthProvider`, the resolved distilled `Credentials`, the
 * `AzureEnvironment` (subscription, tenant, default location), and an
 * `HttpClient`. Include it from your stack alongside other cloud
 * `providers()` layers.
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Azure from "alchemy/Azure";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 *
 * export default Alchemy.Stack(
 *   "MyStack",
 *   {
 *     providers: Azure.providers().pipe(
 *       Layer.provideMerge(Azure.location("westeurope")),
 *     ),
 *     state: Alchemy.localState(),
 *   },
 *   Effect.gen(function* () {
 *     const group = yield* Azure.Resources.ResourceGroup("app");
 *     return { group: group.resourceGroupName };
 *   }),
 * );
 * ```
 */
export const providers = () => (cachedProviders ??= makeProviders());
