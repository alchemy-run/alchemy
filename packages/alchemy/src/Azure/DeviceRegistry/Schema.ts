import * as deviceregistry from "@distilled.cloud/azure/deviceregistry";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEVICE_REGISTRY_RP,
  DEVICE_REGISTRY_WAIT,
  createDeviceRegistryName,
  sameName,
} from "./DeviceRegistryShared.ts";

export type SchemaFormat = deviceregistry.Format;
export type SchemaKind = deviceregistry.SchemaType;

export interface SchemaProps {
  /** Resource group of the schema registry. Changing it replaces the schema. */
  resourceGroup: string;
  /** Name of the parent schema registry. Changing it replaces the schema. */
  schemaRegistry: string;
  /**
   * Schema name: 3-63 lowercase letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the schema.
   */
  name?: string;
  /**
   * Format of the schema's versions. Changing it replaces the schema.
   */
  format: SchemaFormat;
  /**
   * Type of the schema. Changing it replaces the schema.
   * @default "MessageSchema"
   */
  schemaType?: SchemaKind;
  /** Human-readable display name. */
  displayName?: string;
  /** Human-readable description. */
  description?: string;
  /**
   * User tags stored on the schema (`properties.tags`). Alchemy ownership
   * tags (`alchemy::stack`, `alchemy::stage`, `alchemy::id`) are merged in
   * automatically.
   */
  tags?: Record<string, string>;
}

export interface Schema extends Resource<
  "Azure.DeviceRegistry.Schema",
  SchemaProps,
  {
    /** Name of the schema. */
    schemaName: string;
    /** Name of the parent schema registry. */
    schemaRegistry: string;
    /** Resource group of the schema registry. */
    resourceGroup: string;
    /** ARM resource ID of the schema. */
    schemaId: string;
    /** Globally unique, immutable ID Azure assigns to the schema. */
    uuid: string | undefined;
    /** Format of the schema's versions. */
    format: string;
    /** Type of the schema. */
    schemaType: string;
    /** Human-readable display name. */
    displayName: string | undefined;
    /** Human-readable description. */
    description: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A message schema in an Azure Device Registry schema registry. The schema
 * holds metadata; its content lives in immutable
 * {@link SchemaVersion | schema versions}.
 *
 * Schemas have no ARM tags, so Alchemy records ownership in the schema's
 * own `properties.tags`.
 *
 * @see https://learn.microsoft.com/azure/iot-operations/connect-to-cloud/concept-schema-registry
 *
 * ### Creating a Schema
 * **Example:** JSON Schema message schema
 * ```typescript
 * const schema = yield* Azure.DeviceRegistry.Schema("telemetry", {
 *   resourceGroup: group.resourceGroupName,
 *   schemaRegistry: registry.schemaRegistryName,
 *   format: "JsonSchema/draft-07",
 *   displayName: "Telemetry",
 *   description: "Temperature and pressure readings",
 * });
 * ```
 *
 * @resource
 */
export const Schema = Resource<Schema>("Azure.DeviceRegistry.Schema");

const getSchema = (
  subscriptionId: string,
  resourceGroupName: string,
  schemaRegistryName: string,
  schemaName: string,
) =>
  orUndefinedIfNotFound(
    deviceregistry.GetSchema({
      subscriptionId,
      resourceGroupName,
      schemaRegistryName,
      schemaName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  schemaRegistry: string,
  name: string,
  observed: deviceregistry.GetSchemaResponse,
): Schema["Attributes"] => ({
  schemaName: name,
  schemaRegistry,
  resourceGroup,
  schemaId: observed.id ?? "",
  uuid: observed.properties?.uuid,
  format: observed.properties?.format ?? "",
  schemaType: observed.properties?.schemaType ?? "",
  displayName: observed.properties?.displayName,
  description: observed.properties?.description,
  tags: userTags(observed.properties?.tags),
});

export const SchemaProvider = () =>
  Provider.succeed(Schema, {
    stables: ["schemaName", "schemaRegistry", "resourceGroup", "schemaId", "uuid"],

    // Schemas vanish with their registry.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.schemaRegistry, output.schemaRegistry) ||
        (news.name !== undefined && !sameName(news.name, output.schemaName)) ||
        news.format !== output.format ||
        (news.schemaType ?? "MessageSchema") !== output.schemaType
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const schemaRegistry = output?.schemaRegistry ?? olds?.schemaRegistry;
      if (resourceGroup === undefined || schemaRegistry === undefined) {
        return undefined;
      }
      const name =
        output?.schemaName ?? olds?.name ?? (yield* createDeviceRegistryName(id));
      const observed = yield* getSchema(
        subscriptionId,
        resourceGroup,
        schemaRegistry,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, schemaRegistry, name, observed);
      return (yield* isOwned(id, observed.properties?.tags))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, DEVICE_REGISTRY_RP);
      const { resourceGroup, schemaRegistry } = news;
      const name =
        news.name ?? output?.schemaName ?? (yield* createDeviceRegistryName(id));
      const tags = yield* desiredTags(id, news.tags);
      const get = getSchema(subscriptionId, resourceGroup, schemaRegistry, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync. The schema has no PATCH; a PUT with the full
      // properties is the update, so only send it when something differs.
      const props = observed?.properties;
      if (
        observed === undefined ||
        (news.displayName !== undefined &&
          props?.displayName !== news.displayName) ||
        (news.description !== undefined &&
          props?.description !== news.description) ||
        tagsDiffer(props?.tags, tags)
      ) {
        yield* deviceregistry.SchemasCreateOrReplace({
          subscriptionId,
          resourceGroupName: resourceGroup,
          schemaRegistryName: schemaRegistry,
          schemaName: name,
          properties: {
            format: news.format,
            schemaType: news.schemaType ?? "MessageSchema",
            displayName: news.displayName ?? props?.displayName,
            description: news.description ?? props?.description,
            tags,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `schema ${schemaRegistry}/${name}`,
        get,
        (s) => s.properties?.provisioningState,
        DEVICE_REGISTRY_WAIT,
      );
      return toAttrs(resourceGroup, schemaRegistry, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        deviceregistry.DeleteSchema({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          schemaRegistryName: output.schemaRegistry,
          schemaName: output.schemaName,
        }),
      );
      yield* waitUntilGone(
        `schema ${output.schemaRegistry}/${output.schemaName}`,
        getSchema(
          subscriptionId,
          output.resourceGroup,
          output.schemaRegistry,
          output.schemaName,
        ),
        DEVICE_REGISTRY_WAIT,
      );
    }),
  });
