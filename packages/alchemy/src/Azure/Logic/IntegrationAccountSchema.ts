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

export interface IntegrationAccountSchemaProps {
  /** Resource group of the integration account. Changing it replaces the schema. */
  resourceGroup: string;
  /** Name of the integration account. Changing it replaces the schema. */
  integrationAccount: string;
  /**
   * Schema name: 1-80 letters, digits, `-`, `_`, `.`, `(`, `)`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the schema.
   */
  name?: string;
  /** XSD document. */
  content: string;
  /**
   * Schema type.
   * @default "Xml"
   */
  schemaType?: "Xml";
  /**
   * MIME type of the content.
   * @default "application/xml"
   */
  contentType?: string;
  /** Target namespace. Azure derives it from the XSD when omitted. */
  targetNamespace?: string;
  /** Root document name. Azure derives it from the XSD when omitted. */
  documentName?: string;
  /** File name shown in the portal. */
  fileName?: string;
  /**
   * User metadata. Alchemy adds `alchemy::*` ownership and hash keys
   * because artifacts do not return tags.
   */
  metadata?: Record<string, unknown>;
}

export interface IntegrationAccountSchema extends Resource<
  "Azure.Logic.IntegrationAccountSchema",
  IntegrationAccountSchemaProps,
  {
    /** Name of the schema. */
    schemaName: string;
    /** Name of the integration account. */
    integrationAccount: string;
    /** Resource group of the integration account. */
    resourceGroup: string;
    /** ARM resource ID of the schema. */
    schemaId: string;
    /** Target namespace of the schema. */
    targetNamespace: string | undefined;
    /** Root document name. */
    documentName: string | undefined;
    /** Size of the stored content in bytes. */
    contentSize: number | undefined;
    /** Time the schema was last changed. */
    changedTime: string | undefined;
    /** User metadata (Alchemy keys stripped). */
    metadata: Record<string, unknown>;
  },
  never,
  Providers
> {}

/**
 * An XML schema (XSD) in a Logic Apps integration account, used by the
 * XML Validation, Transform XML, and B2B encode/decode actions.
 *
 * Azure stores the content but never returns it, so Alchemy keeps a hash
 * of the desired configuration in the schema's metadata to detect changes.
 *
 * @see https://learn.microsoft.com/azure/logic-apps/logic-apps-enterprise-integration-schemas
 *
 * ### Adding a Schema
 * **Example:** Order schema
 * ```typescript
 * const account = yield* Azure.Logic.IntegrationAccount("b2b", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const order = yield* Azure.Logic.IntegrationAccountSchema("order", {
 *   resourceGroup: group.resourceGroupName,
 *   integrationAccount: account.integrationAccountName,
 *   content: `<?xml version="1.0" encoding="utf-8"?>
 * <xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="http://contoso/order">
 *   <xs:element name="Order" type="xs:string"/>
 * </xs:schema>`,
 * });
 * ```
 *
 * @resource
 */
export const IntegrationAccountSchema = Resource<IntegrationAccountSchema>(
  "Azure.Logic.IntegrationAccountSchema",
);

const getSchema = (
  subscriptionId: string,
  resourceGroupName: string,
  integrationAccountName: string,
  schemaName: string,
) =>
  orUndefinedIfNotFound(
    logic.GetIntegrationAccountSchema({
      subscriptionId,
      resourceGroupName,
      integrationAccountName,
      schemaName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  integrationAccount: string,
  name: string,
  observed: logic.GetIntegrationAccountSchemaResponse,
): IntegrationAccountSchema["Attributes"] => ({
  schemaName: name,
  integrationAccount,
  resourceGroup,
  schemaId: observed.id ?? "",
  targetNamespace: observed.properties.targetNamespace,
  documentName: observed.properties.documentName,
  contentSize: observed.properties.contentLink?.contentSize,
  changedTime: observed.properties.changedTime,
  metadata: userMetadata(observed.properties.metadata),
});

export const IntegrationAccountSchemaProvider = () =>
  Provider.succeed(IntegrationAccountSchema, {
    stables: ["schemaName", "integrationAccount", "resourceGroup", "schemaId"],

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
          news.name.toLowerCase() !== output.schemaName.toLowerCase())
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
        output?.schemaName ?? olds?.name ?? (yield* createLogicName(id));
      const observed = yield* getSchema(
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
        news.name ?? output?.schemaName ?? (yield* createLogicName(id));
      const properties = {
        schemaType: news.schemaType ?? "Xml",
        content: news.content,
        contentType: news.contentType ?? "application/xml",
        targetNamespace: news.targetNamespace,
        documentName: news.documentName,
        fileName: news.fileName,
      };
      const metadata = yield* artifactMetadata(id, news.metadata, {
        [HASH_KEY]: yield* hashOf({ properties, metadata: news.metadata }),
      });

      // Observe.
      let observed = yield* getSchema(
        subscriptionId,
        resourceGroup,
        integrationAccount,
        name,
      );

      // Ensure + sync: the PUT is a synchronous full replacement. Content is
      // never echoed, so its changes surface through the metadata hash.
      if (
        observed === undefined ||
        artifactDiffers(
          observed.properties,
          metadata,
          definedOnly({
            schemaType: properties.schemaType,
            targetNamespace: news.targetNamespace,
            documentName: news.documentName,
            fileName: news.fileName,
          }),
        )
      ) {
        observed = yield* logic.IntegrationAccountSchemasCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          integrationAccountName: integrationAccount,
          schemaName: name,
          properties: { ...properties, metadata },
        });
      }

      return toAttrs(resourceGroup, integrationAccount, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        logic.DeleteIntegrationAccountSchema({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          integrationAccountName: output.integrationAccount,
          schemaName: output.schemaName,
        }),
      );
      yield* waitUntilGone(
        `integration account schema ${output.schemaName}`,
        getSchema(
          subscriptionId,
          output.resourceGroup,
          output.integrationAccount,
          output.schemaName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Logic.IntegrationAccount"] },
  });
