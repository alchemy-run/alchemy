import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileStoreLive } from "../Auth/Profile.ts";
import * as Provider from "../Provider.ts";
import {
  RoleAssignment,
  RoleAssignmentProvider,
} from "./Authorization/RoleAssignment.ts";
import { AzureAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import * as Environment from "./Environment.ts";
import {
  UserAssignedIdentity,
  UserAssignedIdentityProvider,
} from "./ManagedIdentity/UserAssignedIdentity.ts";
import {
  ResourceGroup,
  ResourceGroupProvider,
} from "./Resources/ResourceGroup.ts";
import {
  BlobContainer,
  BlobContainerProvider,
} from "./Storage/BlobContainer.ts";
import {
  StorageAccount,
  StorageAccountProvider,
} from "./Storage/StorageAccount.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Azure",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

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
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      BlobContainer,
      ResourceGroup,
      RoleAssignment,
      StorageAccount,
      UserAssignedIdentity,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        BlobContainerProvider(),
        ResourceGroupProvider(),
        RoleAssignmentProvider(),
        StorageAccountProvider(),
        UserAssignedIdentityProvider(),
      ),
    ),
    Layer.provideMerge(Environment.environmentFromAuthProvider()),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(AzureAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.orDie,
  );
