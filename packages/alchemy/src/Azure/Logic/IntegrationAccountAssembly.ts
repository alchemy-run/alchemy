import * as logic from "@distilled.cloud/azure/logic";
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
  artifactDiffers,
  artifactMetadata,
  createLogicName,
  definedOnly,
  HASH_KEY,
  hashOf,
  isOwnedByMetadata,
  userMetadata,
} from "./LogicShared.ts";

export interface IntegrationAccountAssemblyProps {
  /** Resource group of the integration account. Changing it replaces the assembly. */
  resourceGroup: string;
  /** Name of the integration account. Changing it replaces the assembly. */
  integrationAccount: string;
  /**
   * Assembly name: 1-80 letters, digits, `-`, `_`, `.`, `(`, `)`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the assembly.
   */
  name?: string;
  /** .NET assembly name, e.g. `Contoso.Maps`. */
  assemblyName: string;
  /** Base64-encoded assembly (`.dll`). */
  content: string;
  /**
   * MIME type of the content.
   * @default "application/octet-stream"
   */
  contentType?: string;
  /** Assembly version, e.g. `1.0.0.0`. */
  assemblyVersion?: string;
  /** Assembly culture, e.g. `neutral`. */
  assemblyCulture?: string;
  /** Assembly public key token. */
  assemblyPublicKeyToken?: string;
  /**
   * User metadata. Alchemy adds `alchemy::*` ownership and hash keys
   * because artifacts do not return tags.
   */
  metadata?: Record<string, unknown>;
}

export interface IntegrationAccountAssembly extends Resource<
  "Azure.Logic.IntegrationAccountAssembly",
  IntegrationAccountAssemblyProps,
  {
    /** Name of the assembly artifact in the integration account. */
    assemblyArtifactName: string;
    /** Name of the integration account. */
    integrationAccount: string;
    /** Resource group of the integration account. */
    resourceGroup: string;
    /** ARM resource ID of the assembly. */
    assemblyId: string;
    /** .NET assembly name. */
    assemblyName: string;
    /** Assembly version. */
    assemblyVersion: string | undefined;
    /** Size of the stored content in bytes. */
    contentSize: number | undefined;
    /** Time the assembly was last changed. */
    changedTime: string | undefined;
    /** User metadata (Alchemy keys stripped). */
    metadata: Record<string, unknown>;
  },
  never,
  Providers
> {}

/**
 * A .NET assembly in a Logic Apps integration account, callable from XSLT
 * maps that use custom code.
 *
 * Azure stores the content but never returns it, so Alchemy keeps a hash
 * of the desired configuration in the assembly's metadata to detect
 * changes.
 *
 * @see https://learn.microsoft.com/azure/logic-apps/logic-apps-enterprise-integration-maps#add-referenced-assemblies
 *
 * ### Uploading an Assembly
 * **Example:** Assembly from a base64-encoded DLL
 * ```typescript
 * const helpers = yield* Azure.Logic.IntegrationAccountAssembly("helpers", {
 *   resourceGroup: group.resourceGroupName,
 *   integrationAccount: account.integrationAccountName,
 *   assemblyName: "Contoso.MapHelpers",
 *   assemblyVersion: "1.0.0.0",
 *   assemblyCulture: "neutral",
 *   content: dllBase64,
 * });
 * ```
 *
 * @resource
 */
export const IntegrationAccountAssembly = Resource<IntegrationAccountAssembly>(
  "Azure.Logic.IntegrationAccountAssembly",
);

const getAssembly = (
  subscriptionId: string,
  resourceGroupName: string,
  integrationAccountName: string,
  assemblyArtifactName: string,
) =>
  orUndefinedIfNotFound(
    logic.GetIntegrationAccountAssembly({
      subscriptionId,
      resourceGroupName,
      integrationAccountName,
      assemblyArtifactName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  integrationAccount: string,
  name: string,
  observed: logic.GetIntegrationAccountAssemblyResponse,
): IntegrationAccountAssembly["Attributes"] => ({
  assemblyArtifactName: name,
  integrationAccount,
  resourceGroup,
  assemblyId: observed.id ?? "",
  assemblyName: observed.properties.assemblyName,
  assemblyVersion: observed.properties.assemblyVersion,
  contentSize: observed.properties.contentLink?.contentSize,
  changedTime: observed.properties.changedTime,
  metadata: userMetadata(observed.properties.metadata),
});

export const IntegrationAccountAssemblyProvider = () =>
  Provider.succeed(IntegrationAccountAssembly, {
    stables: [
      "assemblyArtifactName",
      "integrationAccount",
      "resourceGroup",
      "assemblyId",
    ],

    // Artifacts live inside an integration account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.integrationAccount.toLowerCase() !==
          output.integrationAccount.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.assemblyArtifactName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const integrationAccount =
        output?.integrationAccount ?? olds?.integrationAccount;
      if (resourceGroup === undefined || integrationAccount === undefined) {
        return undefined;
      }
      const name =
        output?.assemblyArtifactName ??
        olds?.name ??
        (yield* createLogicName(id));
      const observed = yield* getAssembly(
        subscriptionId,
        resourceGroup,
        integrationAccount,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, integrationAccount, name, observed);
      return (yield* isOwnedByMetadata(id, observed.properties.metadata))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Logic");
      const { resourceGroup, integrationAccount } = news;
      const name =
        news.name ??
        output?.assemblyArtifactName ??
        (yield* createLogicName(id));
      const properties = {
        assemblyName: news.assemblyName,
        content: news.content,
        contentType: news.contentType ?? "application/octet-stream",
        assemblyVersion: news.assemblyVersion,
        assemblyCulture: news.assemblyCulture,
        assemblyPublicKeyToken: news.assemblyPublicKeyToken,
      };
      const metadata = yield* artifactMetadata(id, news.metadata, {
        [HASH_KEY]: yield* hashOf({ properties, metadata: news.metadata }),
      });

      // Observe.
      let observed = yield* getAssembly(
        subscriptionId,
        resourceGroup,
        integrationAccount,
        name,
      );

      // Ensure + sync: the PUT is a synchronous full replacement; changes
      // to fields Azure does not echo surface through the metadata hash.
      if (
        observed === undefined ||
        artifactDiffers(
          observed.properties,
          metadata,
          definedOnly({
            assemblyName: news.assemblyName,
            assemblyVersion: news.assemblyVersion,
            assemblyCulture: news.assemblyCulture,
            assemblyPublicKeyToken: news.assemblyPublicKeyToken,
          }),
        )
      ) {
        observed = yield* logic.IntegrationAccountAssembliesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          integrationAccountName: integrationAccount,
          assemblyArtifactName: name,
          properties: { ...properties, metadata },
        });
      }

      return toAttrs(resourceGroup, integrationAccount, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        logic.DeleteIntegrationAccountAssembly({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          integrationAccountName: output.integrationAccount,
          assemblyArtifactName: output.assemblyArtifactName,
        }),
      );
      yield* waitUntilGone(
        `integration account assembly ${output.assemblyArtifactName}`,
        getAssembly(
          subscriptionId,
          output.resourceGroup,
          output.integrationAccount,
          output.assemblyArtifactName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Logic.IntegrationAccount"] },
  });
