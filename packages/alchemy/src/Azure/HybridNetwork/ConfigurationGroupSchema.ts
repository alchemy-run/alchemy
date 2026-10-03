import * as hybridnetwork from "@distilled.cloud/azure/hybridnetwork";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createHybridNetworkName,
  FAST_BUDGET,
  NAMESPACE,
  retryInProgress,
  sameArm,
  sameJson,
} from "./Common.ts";

export interface ConfigurationGroupSchemaProps {
  /** Resource group of the publisher. Changing it replaces the schema. */
  resourceGroup: string;
  /** Name of the publisher that owns the schema. Changing it replaces the schema. */
  publisher: string;
  /**
   * Schema name: 1-64 letters, digits, `_`, and `-`. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the schema.
   */
  name?: string;
  /**
   * Azure location; must match the publisher's location. Changing it
   * replaces the schema.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * JSON schema (as a JSON string) describing the configuration values a
   * `ConfigurationGroupValue` must provide. Schemas are versioned
   * artifacts: changing it replaces the schema.
   */
  schemaDefinition: string;
  /** Description of what the schema contains. Changing it replaces the schema. */
  description?: string;
  /**
   * Version state of the schema. New schemas start in `Preview`; set
   * `Active` to publish it or `Deprecated` to retire it.
   */
  versionState?: "Preview" | "Active" | "Deprecated";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ConfigurationGroupSchema extends Resource<
  "Azure.HybridNetwork.ConfigurationGroupSchema",
  ConfigurationGroupSchemaProps,
  {
    /** Name of the schema. */
    configurationGroupSchemaName: string;
    /** ARM resource ID of the schema. */
    configurationGroupSchemaId: string;
    /** Name of the publisher that owns the schema. */
    publisher: string;
    /** Resource group of the publisher. */
    resourceGroup: string;
    /** Location of the schema. */
    location: string;
    /** JSON schema definition. */
    schemaDefinition: string;
    /** Description of the schema. */
    description: string | undefined;
    /** Version state (`Preview`, `Active`, `Deprecated`). */
    versionState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Operator Service Manager configuration group schema — a JSON
 * schema a publisher defines for the configuration values operators
 * supply when deploying a network service design.
 *
 * Schemas are free metadata resources.
 *
 * @see https://learn.microsoft.com/azure/operator-service-manager/configuration-guide
 *
 * ### Creating a Schema
 * **Example:** Schema with one required string value
 * ```typescript
 * const schema = yield* Azure.HybridNetwork.ConfigurationGroupSchema("schema", {
 *   resourceGroup: group.resourceGroupName,
 *   publisher: publisher.publisherName,
 *   schemaDefinition: JSON.stringify({
 *     type: "object",
 *     properties: { region: { type: "string" } },
 *     required: ["region"],
 *   }),
 * });
 * ```
 *
 * **Example:** Publish the schema
 * ```typescript
 * const schema = yield* Azure.HybridNetwork.ConfigurationGroupSchema("schema", {
 *   resourceGroup: group.resourceGroupName,
 *   publisher: publisher.publisherName,
 *   schemaDefinition: JSON.stringify({ type: "object" }),
 *   versionState: "Active",
 * });
 * ```
 *
 * @resource
 */
export const ConfigurationGroupSchema = Resource<ConfigurationGroupSchema>(
  "Azure.HybridNetwork.ConfigurationGroupSchema",
);

const getSchema = (
  subscriptionId: string,
  resourceGroupName: string,
  publisherName: string,
  configurationGroupSchemaName: string,
) =>
  orUndefinedIfNotFound(
    hybridnetwork.GetConfigurationGroupSchema({
      subscriptionId,
      resourceGroupName,
      publisherName,
      configurationGroupSchemaName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  publisher: string,
  name: string,
  schema:
    | hybridnetwork.GetConfigurationGroupSchemaResponse
    | hybridnetwork.ConfigurationGroupSchema,
): ConfigurationGroupSchema["Attributes"] => ({
  configurationGroupSchemaName: name,
  configurationGroupSchemaId: schema.id ?? "",
  publisher,
  resourceGroup,
  location: schema.location,
  schemaDefinition: schema.properties?.schemaDefinition ?? "",
  description: schema.properties?.description,
  versionState: schema.properties?.versionState,
  tags: userTags(schema.tags),
});

export const ConfigurationGroupSchemaProvider = () =>
  Provider.succeed(ConfigurationGroupSchema, {
    stables: [
      "configurationGroupSchemaName",
      "configurationGroupSchemaId",
      "publisher",
      "resourceGroup",
      "location",
      "schemaDefinition",
      "description",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const publishers = yield* hybridnetwork
        .ListPublisherBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListPublisherBySubscription", page),
          ),
        );
      const found: ConfigurationGroupSchema["Attributes"][] = [];
      for (const publisher of publishers.value ?? []) {
        const group = resourceGroupOf(publisher.id);
        if (group === undefined || publisher.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          hybridnetwork.ListConfigurationGroupSchemaByPublisher({
            subscriptionId,
            resourceGroupName: group,
            publisherName: publisher.name,
          }),
        );
        if (page !== undefined) {
          yield* requireSinglePage(
            "ListConfigurationGroupSchemaByPublisher",
            page,
          );
        }
        for (const schema of page?.value ?? []) {
          if (hasAnyAlchemyTag(schema.tags) && schema.name !== undefined) {
            found.push(toAttrs(group, publisher.name, schema.name, schema));
          }
        }
      }
      return found;
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      // AOSM normalizes the stored schema (e.g. adds `required`), so the
      // immutable definition is compared against the last applied props.
      const definitionChanged =
        olds !== undefined
          ? !sameJson(news.schemaDefinition, olds.schemaDefinition) ||
            (news.description ?? undefined) !==
              (olds.description ?? undefined)
          : false;
      const sameName =
        news.name === undefined ||
        news.name === output.configurationGroupSchemaName;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.publisher, output.publisher) ||
        !sameName ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        definitionChanged
      ) {
        // An explicit name that stays the same can only be reused once the
        // old schema is gone.
        return {
          action: "replace",
          deleteFirst: news.name !== undefined && sameName,
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const publisher = output?.publisher ?? olds?.publisher;
      if (resourceGroup === undefined || publisher === undefined) {
        return undefined;
      }
      const name =
        output?.configurationGroupSchemaName ??
        olds?.name ??
        (yield* createHybridNetworkName(id));
      const observed = yield* getSchema(
        subscriptionId,
        resourceGroup,
        publisher,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, publisher, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, NAMESPACE);
      const { resourceGroup, publisher } = news;
      const name =
        news.name ??
        output?.configurationGroupSchemaName ??
        (yield* createHybridNetworkName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        publisherName: publisher,
        configurationGroupSchemaName: name,
      };
      const get = getSchema(subscriptionId, resourceGroup, publisher, name);
      const label = `AOSM configuration group schema ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        yield* retryInProgress(
          hybridnetwork.ConfigurationGroupSchemasCreateOrUpdate({
            ...where,
            location,
            tags,
            properties: {
              schemaDefinition: news.schemaDefinition,
              description: news.description,
            },
          }),
        );
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (schema) => schema.properties?.provisioningState,
        FAST_BUDGET,
      );

      // Sync the version state against observed state.
      const versionState = news.versionState;
      if (
        versionState !== undefined &&
        observed.properties?.versionState !== versionState
      ) {
        yield* retryInProgress(
          hybridnetwork.UpdateConfigurationGroupSchemaState({
            ...where,
            versionState,
          }),
        );
        observed = yield* waitForProvisioned(
          label,
          get,
          (schema) =>
            schema.properties?.versionState !== versionState
              ? "Updating"
              : schema.properties?.provisioningState,
          FAST_BUDGET,
        );
      }

      // Sync tags against observed state.
      if (tagsDiffer(observed.tags, tags)) {
        yield* retryInProgress(
          hybridnetwork.UpdateConfigurationGroupSchema({ ...where, tags }),
        );
        observed = yield* waitForProvisioned(
          label,
          get,
          (schema) =>
            tagsDiffer(schema.tags, tags)
              ? "Updating"
              : schema.properties?.provisioningState,
          FAST_BUDGET,
        );
      }

      return toAttrs(resourceGroup, publisher, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hybridnetwork.DeleteConfigurationGroupSchema({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          publisherName: output.publisher,
          configurationGroupSchemaName: output.configurationGroupSchemaName,
        }),
      );
      yield* waitUntilGone(
        `AOSM configuration group schema ${output.configurationGroupSchemaName}`,
        getSchema(
          subscriptionId,
          output.resourceGroup,
          output.publisher,
          output.configurationGroupSchemaName,
        ),
        FAST_BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.HybridNetwork.Publisher",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
