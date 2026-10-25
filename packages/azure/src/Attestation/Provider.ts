import * as attestation from "@distilled.cloud/azure/attestation";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider_ from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";

/** `Enabled` or `Disabled`. */
export type AttestationToggle = "Enabled" | "Disabled";

/** A JSON Web Key (RFC 7517) carrying a policy signing certificate. */
export interface AttestationJsonWebKey {
  /** Key type, e.g. `RSA` or `EC`. */
  kty: string;
  /**
   * Algorithm intended for use with the key, e.g. `RS256`.
   * @default not set
   */
  alg?: string;
  /**
   * Key ID.
   * @default not set
   */
  kid?: string;
  /**
   * Intended use of the key, e.g. `sig`.
   * @default not set
   */
  use?: string;
  /**
   * Base64 (not base64url) DER-encoded X.509 certificate chain.
   * @default none
   */
  x5c?: string[];
  /**
   * RSA modulus.
   * @default not set
   */
  n?: string;
  /**
   * RSA public exponent.
   * @default not set
   */
  e?: string;
  /**
   * EC curve name.
   * @default not set
   */
  crv?: string;
  /**
   * EC x coordinate.
   * @default not set
   */
  x?: string;
  /**
   * EC y coordinate.
   * @default not set
   */
  y?: string;
}

export interface ProviderProps {
  /**
   * Resource group the attestation provider is created in. Changing it
   * replaces the provider.
   */
  resourceGroup: string;
  /**
   * Name of the provider, 3-24 lowercase letters and digits, unique per
   * region (it forms `https://<name>.<region>.attest.azure.net`). If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the provider.
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Azure location of the provider. Changing it replaces the provider.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * X.509 certificates (as JSON Web Keys) that sign attestation policy
   * updates. Setting them switches the provider to the `Isolated` trust
   * model; without them it uses `AAD`. Creation-only: changing them
   * replaces the provider.
   * @default none (the `AAD` trust model)
   */
  policySigningCertificates?: AttestationJsonWebKey[];
  /**
   * Whether the attestation endpoints accept traffic from the public
   * network.
   * @default "Enabled"
   */
  publicNetworkAccess?: AttestationToggle;
  /**
   * Whether the TPM attestation REST APIs require authentication.
   * @default Azure's default (`Enabled`)
   */
  tpmAttestationAuthentication?: AttestationToggle;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface Provider extends Resource<
  "Azure.Attestation.Provider",
  ProviderProps,
  {
    /** Name of the attestation provider. */
    providerName: string;
    /** Resource group that holds the provider. */
    resourceGroup: string;
    /** ARM resource ID of the provider. */
    providerId: string;
    /** Location of the provider. */
    location: string;
    /** Attestation endpoint, e.g. `https://<name>.eus.attest.azure.net`. */
    attestUri: string;
    /** Trust model: `AAD` or `Isolated`. */
    trustModel: string | undefined;
    /** Service status: `Ready`, `NotReady`, or `Error`. */
    status: string | undefined;
    /** Observed public network access setting. */
    publicNetworkAccess: string | undefined;
    /** Observed TPM attestation authentication setting. */
    tpmAttestationAuthentication: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Microsoft Azure Attestation provider
 * (`Microsoft.Attestation/attestationProviders`) — a dedicated attestation
 * instance that verifies SGX, VBS, TPM, and SEV-SNP evidence and issues
 * signed tokens against your own policies. The provider itself is free.
 *
 * :::caution
 * Changing `name`, `location`, `policySigningCertificates`, or
 * `resourceGroup` replaces the provider.
 * :::
 *
 * @see https://learn.microsoft.com/azure/attestation/overview
 *
 * ### Creating a Provider
 * **Example:** Attestation provider with the AAD trust model
 * ```typescript
 * const attest = yield* Azure.Attestation.Provider("attest");
 * // attest.attestUri => https://<name>.eus.attest.azure.net
 * ```
 *
 * ### Isolated Trust Model
 * **Example:** Require policy updates to be signed by your certificate
 * ```typescript
 * // Base64 DER of the X.509 certificate that signs policy updates.
 * const certificate = yield* Config.string("ATTESTATION_SIGNING_CERT");
 * const attest = yield* Azure.Attestation.Provider("attest", {
 *   policySigningCertificates: [{ kty: "RSA", x5c: [certificate] }],
 * });
 * ```
 *
 * ### Private Access
 * **Example:** Disable the public endpoint
 * ```typescript
 * const attest = yield* Azure.Attestation.Provider("attest", {
 *   publicNetworkAccess: "Disabled",
 * });
 * ```
 *
 * @resource
 */
export const Provider = GroupedResource<Provider>("Azure.Attestation.Provider");

type ObservedProvider = attestation.GetAttestationProviderResponse;

const createProviderName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 24,
    lowercase: true,
    delimiter: "",
  });
  return name.replace(/[^a-z0-9]/g, "");
});

const getProvider = (subscriptionId: string, resourceGroupName: string, providerName: string) =>
  orUndefinedIfNotFound(
    attestation.GetAttestationProvider({
      subscriptionId,
      resourceGroupName,
      providerName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: ObservedProvider | attestation.AttestationProvider,
): Provider["Attributes"] => ({
  providerName: name,
  resourceGroup,
  providerId: observed.id ?? "",
  location: observed.location,
  attestUri: observed.properties?.attestUri ?? "",
  trustModel: observed.properties?.trustModel,
  status: observed.properties?.status,
  publicNetworkAccess: observed.properties?.publicNetworkAccess,
  tpmAttestationAuthentication: observed.properties?.tpmAttestationAuthentication,
  tags: userTags(observed.tags),
});

const certificatesKey = (certs: AttestationJsonWebKey[] | undefined) => JSON.stringify(certs ?? []);

const same = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

export const ProviderProvider = () =>
  Provider_.succeed(Provider, {
    stables: ["providerName", "resourceGroup", "providerId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // ListAttestationProviders has no nextLink: the API returns a single page.
      const page = yield* attestation.ListAttestationProviders({
        subscriptionId,
      });
      return (page.value ?? []).flatMap((provider) => {
        const group = resourceGroupOf(provider.id);
        return hasAnyAlchemyTag(provider.tags) &&
          group !== undefined &&
          provider.name !== undefined &&
          provider.location !== undefined
          ? [toAttrs(group, provider.name, provider)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !same(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !same(news.name, output.providerName)) ||
        (news.location !== undefined &&
          !same(news.location.replace(/\s/g, ""), output.location.replace(/\s/g, ""))) ||
        (olds !== undefined &&
          certificatesKey(news.policySigningCertificates) !==
            certificatesKey(olds.policySigningCertificates))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.providerName ?? olds?.name ?? (yield* createProviderName(id));
      const observed = yield* getProvider(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Attestation");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.providerName ?? (yield* createProviderName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const publicNetworkAccess = news.publicNetworkAccess ?? "Enabled";

      // Observe.
      let observed = yield* getProvider(subscriptionId, resourceGroup, name);

      // Ensure: the PUT is synchronous and carries the creation-only
      // policy signing certificates.
      if (observed === undefined) {
        yield* attestation.CreateAttestationProvider({
          subscriptionId,
          resourceGroupName: resourceGroup,
          providerName: name,
          location,
          tags,
          properties: {
            publicNetworkAccess,
            tpmAttestationAuthentication: news.tpmAttestationAuthentication,
            policySigningCertificates:
              news.policySigningCertificates === undefined
                ? undefined
                : { keys: news.policySigningCertificates },
          },
        });
        observed = yield* getProvider(subscriptionId, resourceGroup, name);
      }

      // Sync mutable settings + tags against the observed provider.
      const props = observed?.properties;
      const patch: attestation.AttestationServicePatchSpecificParams = {};
      if (!same(props?.publicNetworkAccess, publicNetworkAccess)) {
        patch.publicNetworkAccess = publicNetworkAccess;
      }
      if (
        news.tpmAttestationAuthentication !== undefined &&
        !same(props?.tpmAttestationAuthentication, news.tpmAttestationAuthentication)
      ) {
        patch.tpmAttestationAuthentication = news.tpmAttestationAuthentication;
      }
      const tagsChanged = tagsDiffer(observed?.tags, tags);
      if (Object.keys(patch).length > 0 || tagsChanged) {
        yield* attestation.UpdateAttestationProvider({
          subscriptionId,
          resourceGroupName: resourceGroup,
          providerName: name,
          tags: tagsChanged ? tags : undefined,
          properties: Object.keys(patch).length > 0 ? patch : undefined,
        });
      }

      const fresh = yield* attestation.GetAttestationProvider({
        subscriptionId,
        resourceGroupName: resourceGroup,
        providerName: name,
      });
      return toAttrs(resourceGroup, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        attestation.DeleteAttestationProvider({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          providerName: output.providerName,
        }),
      );
      yield* waitUntilGone(
        `attestation provider ${output.providerName}`,
        getProvider(subscriptionId, output.resourceGroup, output.providerName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
