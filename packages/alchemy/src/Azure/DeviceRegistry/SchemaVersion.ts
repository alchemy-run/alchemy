import * as deviceregistry from "@distilled.cloud/azure/deviceregistry";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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
  DEVICE_REGISTRY_RP,
  DEVICE_REGISTRY_WAIT,
  sameName,
} from "./DeviceRegistryShared.ts";

export interface SchemaVersionProps {
  /** Resource group of the schema registry. Changing it replaces the version. */
  resourceGroup: string;
  /** Name of the schema registry. Changing it replaces the version. */
  schemaRegistry: string;
  /** Name of the parent schema. Changing it replaces the version. */
  schema: string;
  /**
   * Version name — a positive integer as a string, e.g. `"1"`. Changing it
   * creates a new version and deletes the old one.
   */
  version: string;
  /**
   * Schema content in the parent schema's format (e.g. a JSON Schema
   * draft-07 document as a string). Versions are immutable; changing the
   * content replaces the version.
   */
  schemaContent: string;
  /**
   * Human-readable description of the version. Changing it replaces the
   * version.
   */
  description?: string;
}

export interface SchemaVersion extends Resource<
  "Azure.DeviceRegistry.SchemaVersion",
  SchemaVersionProps,
  {
    /** Version name. */
    version: string;
    /** Name of the parent schema. */
    schema: string;
    /** Name of the schema registry. */
    schemaRegistry: string;
    /** Resource group of the schema registry. */
    resourceGroup: string;
    /** ARM resource ID of the version. */
    schemaVersionId: string;
    /** Globally unique, immutable ID Azure assigns to the version. */
    uuid: string | undefined;
    /** Hash of the schema content, computed by Azure. */
    hash: string | undefined;
    /** Schema content. */
    schemaContent: string;
    /** Human-readable description. */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An immutable version of a message schema in an Azure Device Registry
 * schema registry. The registry writes the content to its blob container
 * with its managed identity, so the identity needs
 * `Storage Blob Data Contributor` on the container first (a fresh role
 * assignment is retried for up to five minutes while it propagates).
 *
 * Versions carry no tags or free-form fields, so Alchemy cannot mark them;
 * a version found under the expected name is treated as this resource.
 *
 * @see https://learn.microsoft.com/azure/iot-operations/connect-to-cloud/concept-schema-registry
 *
 * ### Publishing a Version
 * **Example:** JSON Schema version
 * ```typescript
 * const v1 = yield* Azure.DeviceRegistry.SchemaVersion("telemetry-v1", {
 *   resourceGroup: group.resourceGroupName,
 *   schemaRegistry: registry.schemaRegistryName,
 *   schema: schema.schemaName,
 *   version: "1",
 *   schemaContent: JSON.stringify({
 *     $schema: "http://json-schema.org/draft-07/schema#",
 *     type: "object",
 *     properties: { temperature: { type: "number" } },
 *   }),
 * });
 * ```
 *
 * @resource
 */
export const SchemaVersion = Resource<SchemaVersion>(
  "Azure.DeviceRegistry.SchemaVersion",
);

const getVersion = (
  subscriptionId: string,
  resourceGroupName: string,
  schemaRegistryName: string,
  schemaName: string,
  schemaVersionName: string,
) =>
  orUndefinedIfNotFound(
    deviceregistry.GetSchemaVersion({
      subscriptionId,
      resourceGroupName,
      schemaRegistryName,
      schemaName,
      schemaVersionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  schemaRegistry: string,
  schema: string,
  version: string,
  observed: deviceregistry.GetSchemaVersionResponse,
): SchemaVersion["Attributes"] => ({
  version,
  schema,
  schemaRegistry,
  resourceGroup,
  schemaVersionId: observed.id ?? "",
  uuid: observed.properties?.uuid,
  hash: observed.properties?.hash,
  schemaContent: observed.properties?.schemaContent ?? "",
  description: observed.properties?.description,
});

export const SchemaVersionProvider = () =>
  Provider.succeed(SchemaVersion, {
    stables: [
      "version",
      "schema",
      "schemaRegistry",
      "resourceGroup",
      "schemaVersionId",
      "uuid",
    ],

    // Versions vanish with their schema.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const moved =
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.schemaRegistry, output.schemaRegistry) ||
        !sameName(news.schema, output.schema) ||
        news.version !== output.version;
      if (
        moved ||
        news.schemaContent !== output.schemaContent ||
        (news.description !== undefined &&
          news.description !== output.description)
      ) {
        // Same name, new payload: the old version must go first.
        return { action: "replace", deleteFirst: !moved } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const schemaRegistry = output?.schemaRegistry ?? olds?.schemaRegistry;
      const schema = output?.schema ?? olds?.schema;
      const version = output?.version ?? olds?.version;
      if (
        resourceGroup === undefined ||
        schemaRegistry === undefined ||
        schema === undefined ||
        version === undefined
      ) {
        return undefined;
      }
      const observed = yield* getVersion(
        subscriptionId,
        resourceGroup,
        schemaRegistry,
        schema,
        version,
      );
      return observed === undefined
        ? undefined
        : toAttrs(resourceGroup, schemaRegistry, schema, version, observed);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, DEVICE_REGISTRY_RP);
      const { resourceGroup, schemaRegistry, schema, version } = news;
      const get = getVersion(
        subscriptionId,
        resourceGroup,
        schemaRegistry,
        schema,
        version,
      );

      // Observe.
      const observed = yield* get;

      // Ensure. Content and description are the version's only aspects.
      if (
        observed === undefined ||
        observed.properties?.schemaContent !== news.schemaContent ||
        (news.description !== undefined &&
          observed.properties?.description !== news.description)
      ) {
        yield* deviceregistry
          .SchemaVersionsCreateOrReplace({
            subscriptionId,
            resourceGroupName: resourceGroup,
            schemaRegistryName: schemaRegistry,
            schemaName: schema,
            schemaVersionName: version,
            properties: {
              schemaContent: news.schemaContent,
              description: news.description,
            },
          })
          .pipe(
            // A fresh role assignment for the registry's identity on the
            // storage container takes a few minutes to propagate.
            Effect.retry({
              while: (e) => e._tag === "SchemaRegistryStorageAccessDenied",
              schedule: Schedule.spaced("10 seconds"),
              times: 30,
            }),
          );
      }

      const fresh = yield* waitForProvisioned(
        `schema version ${schema}/${version}`,
        get,
        (v) => v.properties?.provisioningState,
        DEVICE_REGISTRY_WAIT,
      );
      return toAttrs(resourceGroup, schemaRegistry, schema, version, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        deviceregistry.DeleteSchemaVersion({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          schemaRegistryName: output.schemaRegistry,
          schemaName: output.schema,
          schemaVersionName: output.version,
        }),
      );
      yield* waitUntilGone(
        `schema version ${output.schema}/${output.version}`,
        getVersion(
          subscriptionId,
          output.resourceGroup,
          output.schemaRegistry,
          output.schema,
          output.version,
        ),
        DEVICE_REGISTRY_WAIT,
      );
    }),
  });
