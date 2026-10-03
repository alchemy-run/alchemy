import * as datafactory from "@distilled.cloud/azure/datafactory";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  annotationsWithOwnership,
  createChildName,
  definitionDiffers,
  hasOwnershipAnnotation,
  ownershipAnnotation,
  userAnnotations,
} from "./FactoryChild.ts";

export type CredentialType = "ManagedIdentity" | "ServicePrincipal";

export interface CredentialProps {
  /** Resource group of the factory. Changing it replaces the credential. */
  resourceGroup: string;
  /** Name of the factory that holds the credential. Changing it replaces the credential. */
  factoryName: string;
  /**
   * Credential name: 1-127 letters, digits, `_`, and `-`, starting and
   * ending with a letter, digit, or `_`. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * credential.
   */
  name?: string;
  /**
   * Credential type. Changing it replaces the credential.
   * @default "ManagedIdentity"
   */
  type?: CredentialType;
  /**
   * ARM resource ID of the user-assigned identity (`ManagedIdentity`
   * credentials). The identity must also be attached to the factory via
   * `identity.userAssignedIdentities`.
   */
  resourceId?: string;
  /**
   * Other type-specific properties, e.g. `servicePrincipalId` and
   * `servicePrincipalKey` (a Key Vault secret reference) for
   * `ServicePrincipal` credentials. Merged with `resourceId`.
   */
  typeProperties?: Record<string, unknown>;
  /** Credential description. */
  description?: string;
  /**
   * Annotations shown in the authoring UI. Alchemy appends an ownership
   * annotation (`alchemy:<stack>/<stage>/<id>`).
   */
  annotations?: string[];
}

export interface Credential extends Resource<
  "Azure.DataFactory.Credential",
  CredentialProps,
  {
    /** Name of the credential. */
    credentialName: string;
    /** Name of the factory that holds the credential. */
    factoryName: string;
    /** Resource group of the factory. */
    resourceGroup: string;
    /** ARM resource ID of the credential. */
    credentialId: string;
    /** Credential type. */
    type: string;
    /** Entity tag of the current definition. */
    etag: string | undefined;
    /** User annotations (Alchemy ownership annotation stripped). */
    annotations: unknown[];
  },
  never,
  Providers
> {}

/**
 * A Data Factory credential — a user-assigned managed identity or service
 * principal that linked services authenticate as, referenced by name from
 * a linked service's `credential` property.
 *
 * @see https://learn.microsoft.com/azure/data-factory/credentials
 *
 * ### Managed Identity Credentials
 * **Example:** Credential for a user-assigned identity
 * ```typescript
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("etl", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const factory = yield* Azure.DataFactory.Factory("etl", {
 *   resourceGroup: group.resourceGroupName,
 *   identity: {
 *     type: "UserAssigned",
 *     userAssignedIdentities: [identity.identityId],
 *   },
 * });
 * const credential = yield* Azure.DataFactory.Credential("etl", {
 *   resourceGroup: group.resourceGroupName,
 *   factoryName: factory.factoryName,
 *   resourceId: identity.identityId,
 * });
 * ```
 *
 * **Example:** Linked service that authenticates with the credential
 * ```typescript
 * yield* Azure.DataFactory.LinkedService("blob", {
 *   resourceGroup: group.resourceGroupName,
 *   factoryName: factory.factoryName,
 *   type: "AzureBlobStorage",
 *   typeProperties: {
 *     serviceEndpoint: "https://myaccount.blob.core.windows.net/",
 *     credential: {
 *       referenceName: credential.credentialName,
 *       type: "CredentialReference",
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Credential = Resource<Credential>("Azure.DataFactory.Credential");

const createCredentialName = Effect.fn(function* (id: string) {
  const name = yield* createChildName(id);
  return name.slice(0, 127);
});

const getCredential = (
  subscriptionId: string,
  resourceGroupName: string,
  factoryName: string,
  credentialName: string,
) =>
  orUndefinedIfNotFound(
    datafactory.GetCredentialOperation({
      subscriptionId,
      resourceGroupName,
      factoryName,
      credentialName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  factoryName: string,
  name: string,
  observed: datafactory.GetCredentialOperationResponse,
): Credential["Attributes"] => ({
  credentialName: name,
  factoryName,
  resourceGroup,
  credentialId: observed.id ?? "",
  type: observed.properties.type,
  etag: observed.etag,
  annotations: userAnnotations(observed.properties.annotations),
});

export const CredentialProvider = () =>
  Provider.succeed(Credential, {
    stables: [
      "credentialName",
      "factoryName",
      "resourceGroup",
      "credentialId",
      "type",
    ],

    // Credentials live inside a factory; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.factoryName.toLowerCase() !== output.factoryName.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.credentialName.toLowerCase()) ||
        (news.type ?? "ManagedIdentity") !== output.type
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const factoryName = output?.factoryName ?? olds?.factoryName;
      if (resourceGroup === undefined || factoryName === undefined) {
        return undefined;
      }
      const name =
        output?.credentialName ??
        olds?.name ??
        (yield* createCredentialName(id));
      const observed = yield* getCredential(
        subscriptionId,
        resourceGroup,
        factoryName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, factoryName, name, observed);
      const marker = yield* ownershipAnnotation(id);
      return hasOwnershipAnnotation(marker, observed.properties.annotations)
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DataFactory");
      const { resourceGroup, factoryName } = news;
      const name =
        news.name ??
        output?.credentialName ??
        (yield* createCredentialName(id));
      const marker = yield* ownershipAnnotation(id);
      const typeProperties =
        news.resourceId !== undefined || news.typeProperties !== undefined
          ? {
              ...news.typeProperties,
              ...(news.resourceId !== undefined
                ? { resourceId: news.resourceId }
                : {}),
            }
          : undefined;
      const desired = {
        type: news.type ?? "ManagedIdentity",
        typeProperties,
        description: news.description,
        annotations: annotationsWithOwnership(news.annotations, marker),
      };

      // Observe.
      let observed = yield* getCredential(
        subscriptionId,
        resourceGroup,
        factoryName,
        name,
      );

      // Ensure + sync with one synchronous full-definition PUT, skipped
      // when the observed definition already matches.
      if (
        observed === undefined ||
        definitionDiffers(desired, observed.properties)
      ) {
        observed = yield* datafactory.CredentialOperationsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          factoryName,
          credentialName: name,
          properties: desired,
        });
      }

      return toAttrs(resourceGroup, factoryName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        datafactory.DeleteCredentialOperation({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          factoryName: output.factoryName,
          credentialName: output.credentialName,
        }),
      );
      yield* waitUntilGone(
        `credential ${output.credentialName}`,
        getCredential(
          subscriptionId,
          output.resourceGroup,
          output.factoryName,
          output.credentialName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.DataFactory.Factory"] },
  });
