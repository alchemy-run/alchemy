import * as containerregistry from "@distilled.cloud/azure/containerregistry";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createRegistryName,
  registryOwnedByStage,
  sameName,
} from "./Common.ts";

export interface CredentialSetProps {
  /** Resource group of the registry. Changing it replaces the credential set. */
  resourceGroup: string;
  /** Registry that holds the credential set. Changing it replaces the credential set. */
  registry: string;
  /**
   * Credential set name: 5-50 letters, digits, hyphens, and underscores. If
   * omitted, a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the credential set.
   */
  name?: string;
  /**
   * Upstream login server the credentials are for, e.g. `docker.io`.
   * Changing it replaces the credential set.
   */
  loginServer: string;
  /**
   * Key Vault secret URI holding the upstream username, e.g.
   * `https://myvault.vault.azure.net/secrets/dockerhub-username`.
   */
  usernameSecretIdentifier: string;
  /** Key Vault secret URI holding the upstream password or access token. */
  passwordSecretIdentifier: string;
}

export interface CredentialSet extends Resource<
  "Azure.ContainerRegistry.CredentialSet",
  CredentialSetProps,
  {
    /** Name of the credential set. */
    credentialSetName: string;
    /** ARM resource ID of the credential set; pass it to a `CacheRule`. */
    credentialSetId: string;
    /** Registry that holds the credential set. */
    registry: string;
    /** Resource group of the registry. */
    resourceGroup: string;
    /** Upstream login server. */
    loginServer: string;
    /**
     * Principal ID of the credential set's system-assigned identity. Grant
     * it `Key Vault Secrets User` on the vault holding the secrets.
     */
    principalId: string | undefined;
    /** Health of the stored credential (`Healthy` / `Unhealthy`). */
    credentialHealth: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A credential set — upstream registry credentials (stored as Key Vault
 * secret references) used by artifact `CacheRule`s.
 *
 * The credential set gets a system-assigned identity; grant it read access
 * to the secrets (e.g. `Key Vault Secrets User`) so ACR can resolve them.
 * Credential sets have no tags; Alchemy treats one as owned when its
 * registry carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/container-registry/artifact-cache-overview
 *
 * ### Authenticating an Upstream
 * **Example:** Docker Hub credentials for a cache rule
 * ```typescript
 * const dockerHub = yield* Azure.ContainerRegistry.CredentialSet("dockerhub", {
 *   resourceGroup: group.resourceGroupName,
 *   registry: registry.registryName,
 *   loginServer: "docker.io",
 *   usernameSecretIdentifier: "https://myvault.vault.azure.net/secrets/hub-user",
 *   passwordSecretIdentifier: "https://myvault.vault.azure.net/secrets/hub-token",
 * });
 * const nginx = yield* Azure.ContainerRegistry.CacheRule("nginx", {
 *   resourceGroup: group.resourceGroupName,
 *   registry: registry.registryName,
 *   sourceRepository: "docker.io/library/nginx",
 *   targetRepository: "nginx",
 *   credentialSetResourceId: dockerHub.credentialSetId,
 * });
 * ```
 *
 * @resource
 */
export const CredentialSet = Resource<CredentialSet>(
  "Azure.ContainerRegistry.CredentialSet",
);

const getCredentialSet = (
  subscriptionId: string,
  resourceGroupName: string,
  registryName: string,
  credentialSetName: string,
) =>
  orUndefinedIfNotFound(
    containerregistry.GetCredentialSet({
      subscriptionId,
      resourceGroupName,
      registryName,
      credentialSetName,
    }),
  );

const reveal = (value: string | Redacted.Redacted<string> | undefined) =>
  value !== undefined && Redacted.isRedacted(value)
    ? Redacted.value(value)
    : value;

const toAttrs = (
  resourceGroup: string,
  registry: string,
  name: string,
  set: containerregistry.GetCredentialSetResponse,
): CredentialSet["Attributes"] => ({
  credentialSetName: name,
  credentialSetId: set.id ?? "",
  registry,
  resourceGroup,
  loginServer: set.properties?.loginServer ?? "",
  principalId: set.identity?.principalId,
  credentialHealth:
    set.properties?.authCredentials?.[0]?.credentialHealth?.status,
});

export const CredentialSetProvider = () =>
  Provider.succeed(CredentialSet, {
    stables: [
      "credentialSetName",
      "credentialSetId",
      "registry",
      "resourceGroup",
      "loginServer",
    ],

    // Credential sets live inside a registry; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.registry, output.registry) ||
        (news.name !== undefined &&
          !sameName(news.name, output.credentialSetName)) ||
        !sameName(news.loginServer, output.loginServer)
      ) {
        // A kept explicit name must be freed before it can be reused.
        return {
          action: "replace",
          deleteFirst:
            news.name !== undefined &&
            sameName(news.name, output.credentialSetName),
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const registry = output?.registry ?? olds?.registry;
      if (resourceGroup === undefined || registry === undefined) {
        return undefined;
      }
      const name =
        output?.credentialSetName ??
        olds?.name ??
        (yield* createRegistryName(id));
      const observed = yield* getCredentialSet(
        subscriptionId,
        resourceGroup,
        registry,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, registry, name, observed);
      return (yield* registryOwnedByStage(
        subscriptionId,
        resourceGroup,
        registry,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ContainerRegistry");
      const { resourceGroup, registry } = news;
      const name =
        news.name ??
        output?.credentialSetName ??
        (yield* createRegistryName(id));
      const authCredentials = [
        {
          name: "Credential1" as const,
          usernameSecretIdentifier: news.usernameSecretIdentifier,
          passwordSecretIdentifier: news.passwordSecretIdentifier,
        },
      ];
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        registryName: registry,
        credentialSetName: name,
      };
      const get = getCredentialSet(
        subscriptionId,
        resourceGroup,
        registry,
        name,
      );
      const waitReady = waitForProvisioned(
        `credential set ${name}`,
        get,
        (set) => set.properties?.provisioningState,
        { interval: "2 seconds", times: 30 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* containerregistry.CreateCredentialSet({
          ...where,
          identity: { type: "SystemAssigned" },
          properties: { loginServer: news.loginServer, authCredentials },
        });
      }
      observed = yield* waitReady;

      // Sync the secret references against the observed credential.
      const current = observed.properties?.authCredentials?.[0];
      if (
        current?.usernameSecretIdentifier !== news.usernameSecretIdentifier ||
        reveal(current?.passwordSecretIdentifier) !==
          news.passwordSecretIdentifier ||
        observed.identity?.type?.toLowerCase() !== "systemassigned"
      ) {
        yield* containerregistry.UpdateCredentialSet({
          ...where,
          identity: { type: "SystemAssigned" },
          properties: { authCredentials },
        });
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, registry, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        containerregistry.DeleteCredentialSet({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          registryName: output.registry,
          credentialSetName: output.credentialSetName,
        }),
      );
      yield* waitUntilGone(
        `credential set ${output.credentialSetName}`,
        getCredentialSet(
          subscriptionId,
          output.resourceGroup,
          output.registry,
          output.credentialSetName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.ContainerRegistry.Registry",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
