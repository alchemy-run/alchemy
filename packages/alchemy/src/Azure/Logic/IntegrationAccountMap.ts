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

/** Transform language of a map. */
export type IntegrationAccountMapType = "Xslt" | "Xslt20" | "Xslt30" | "Liquid";

export interface IntegrationAccountMapProps {
  /** Resource group of the integration account. Changing it replaces the map. */
  resourceGroup: string;
  /** Name of the integration account. Changing it replaces the map. */
  integrationAccount: string;
  /**
   * Map name: 1-80 letters, digits, `-`, `_`, `.`, `(`, `)`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the map.
   */
  name?: string;
  /** Transform language. Changing it replaces the map. */
  mapType: IntegrationAccountMapType;
  /** Map document (XSLT stylesheet or Liquid template). */
  content: string;
  /**
   * MIME type of the content.
   * @default "text/plain" for Liquid, else "application/xml"
   */
  contentType?: string;
  /** Reference to the schema of the map's parameters. */
  parametersSchema?: { ref?: string };
  /**
   * User metadata. Alchemy adds `alchemy::*` ownership and hash keys
   * because artifacts do not return tags.
   */
  metadata?: Record<string, unknown>;
}

export interface IntegrationAccountMap extends Resource<
  "Azure.Logic.IntegrationAccountMap",
  IntegrationAccountMapProps,
  {
    /** Name of the map. */
    mapName: string;
    /** Name of the integration account. */
    integrationAccount: string;
    /** Resource group of the integration account. */
    resourceGroup: string;
    /** ARM resource ID of the map. */
    mapId: string;
    /** Transform language. */
    mapType: string;
    /** Size of the stored content in bytes. */
    contentSize: number | undefined;
    /** Time the map was last changed. */
    changedTime: string | undefined;
    /** User metadata (Alchemy keys stripped). */
    metadata: Record<string, unknown>;
  },
  never,
  Providers
> {}

/**
 * A map (XSLT or Liquid transform) in a Logic Apps integration account,
 * used by the Transform XML and Liquid actions.
 *
 * Azure stores the content but never returns it, so Alchemy keeps a hash
 * of the desired configuration in the map's metadata to detect changes.
 *
 * @see https://learn.microsoft.com/azure/logic-apps/logic-apps-enterprise-integration-maps
 *
 * ### Adding a Map
 * **Example:** Liquid JSON-to-JSON map
 * ```typescript
 * const map = yield* Azure.Logic.IntegrationAccountMap("greeting", {
 *   resourceGroup: group.resourceGroupName,
 *   integrationAccount: account.integrationAccountName,
 *   mapType: "Liquid",
 *   content: '{ "greeting": "Hello {{ content.name }}" }',
 * });
 * ```
 *
 * **Example:** XSLT map
 * ```typescript
 * const map = yield* Azure.Logic.IntegrationAccountMap("order-to-invoice", {
 *   resourceGroup: group.resourceGroupName,
 *   integrationAccount: account.integrationAccountName,
 *   mapType: "Xslt",
 *   content: xsltStylesheet,
 * });
 * ```
 *
 * @resource
 */
export const IntegrationAccountMap = Resource<IntegrationAccountMap>(
  "Azure.Logic.IntegrationAccountMap",
);

const getMap = (
  subscriptionId: string,
  resourceGroupName: string,
  integrationAccountName: string,
  mapName: string,
) =>
  orUndefinedIfNotFound(
    logic.GetIntegrationAccountMap({
      subscriptionId,
      resourceGroupName,
      integrationAccountName,
      mapName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  integrationAccount: string,
  name: string,
  observed: logic.GetIntegrationAccountMapResponse,
): IntegrationAccountMap["Attributes"] => ({
  mapName: name,
  integrationAccount,
  resourceGroup,
  mapId: observed.id ?? "",
  mapType: observed.properties.mapType,
  contentSize: observed.properties.contentLink?.contentSize,
  changedTime: observed.properties.changedTime,
  metadata: userMetadata(observed.properties.metadata),
});

export const IntegrationAccountMapProvider = () =>
  Provider.succeed(IntegrationAccountMap, {
    stables: ["mapName", "integrationAccount", "resourceGroup", "mapId"],

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
          news.name.toLowerCase() !== output.mapName.toLowerCase()) ||
        news.mapType.toLowerCase() !== output.mapType.toLowerCase()
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
        output?.mapName ?? olds?.name ?? (yield* createLogicName(id));
      const observed = yield* getMap(
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
      const name = news.name ?? output?.mapName ?? (yield* createLogicName(id));
      const properties = {
        mapType: news.mapType,
        content: news.content,
        contentType:
          news.contentType ??
          (news.mapType === "Liquid" ? "text/plain" : "application/xml"),
        parametersSchema: news.parametersSchema,
      };
      const metadata = yield* artifactMetadata(id, news.metadata, {
        [HASH_KEY]: yield* hashOf({ properties, metadata: news.metadata }),
      });

      // Observe.
      let observed = yield* getMap(
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
            mapType: news.mapType,
            parametersSchema: news.parametersSchema,
          }),
        )
      ) {
        observed = yield* logic.IntegrationAccountMapsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          integrationAccountName: integrationAccount,
          mapName: name,
          properties: { ...properties, metadata },
        });
      }

      return toAttrs(resourceGroup, integrationAccount, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        logic.DeleteIntegrationAccountMap({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          integrationAccountName: output.integrationAccount,
          mapName: output.mapName,
        }),
      );
      yield* waitUntilGone(
        `integration account map ${output.mapName}`,
        getMap(
          subscriptionId,
          output.resourceGroup,
          output.integrationAccount,
          output.mapName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Logic.IntegrationAccount"] },
  });
