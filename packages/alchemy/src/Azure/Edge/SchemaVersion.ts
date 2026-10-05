import * as edge from "@distilled.cloud/azure/edge";
import * as Effect from "effect/Effect";
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
import { EDGE_WAIT, edgeState } from "./EdgeShared.ts";

export interface SchemaVersionProps {
  /** Resource group of the schema. Changing it replaces the version. */
  resourceGroup: string;
  /** Name of the parent schema. Changing it replaces the version. */
  schema: string;
  /**
   * Semantic version, e.g. `1.0.0`. Versions are immutable; changing it
   * creates a new version and deletes the old one.
   */
  version: string;
  /**
   * Schema rules as YAML (`rules: configs: ...`). Versions are immutable;
   * changing the value replaces the version.
   */
  value: string;
}

export interface SchemaVersion extends Resource<
  "Azure.Edge.SchemaVersion",
  SchemaVersionProps,
  {
    /** Version name. */
    version: string;
    /** Name of the parent schema. */
    schema: string;
    /** Resource group of the schema. */
    resourceGroup: string;
    /** ARM resource ID of the version. */
    schemaVersionId: string;
    /** Schema rules YAML. */
    value: string;
  },
  never,
  Providers
> {}

/**
 * An immutable version of an Azure Arc workload orchestration schema.
 * The YAML `value` declares the configuration keys, their types, and who
 * may edit them.
 *
 * Versions carry no tags or free-form fields, so Alchemy cannot mark them;
 * a version found under the expected name is treated as this resource.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/workload-orchestration/configuration-model
 *
 * ### Publishing a Version
 * **Example:** Schema rules
 * ```typescript
 * const v1 = yield* Azure.Edge.SchemaVersion("app-v1", {
 *   resourceGroup: group.resourceGroupName,
 *   schema: schema.schemaName,
 *   version: "1.0.0",
 *   value: [
 *     "rules:",
 *     "  configs:",
 *     "    ErrorThreshold:",
 *     "      type: float",
 *     "      required: true",
 *     "      editableBy:",
 *     "        - OT",
 *   ].join("\n"),
 * });
 * ```
 *
 * @resource
 */
export const SchemaVersion = Resource<SchemaVersion>(
  "Azure.Edge.SchemaVersion",
);

const getVersion = (
  subscriptionId: string,
  resourceGroupName: string,
  schemaName: string,
  schemaVersionName: string,
) =>
  orUndefinedIfNotFound(
    edge.GetSchemaVersion({
      subscriptionId,
      resourceGroupName,
      schemaName,
      schemaVersionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  schema: string,
  version: string,
  observed: edge.GetSchemaVersionResponse,
): SchemaVersion["Attributes"] => ({
  version,
  schema,
  resourceGroup,
  schemaVersionId: observed.id ?? "",
  value: observed.properties?.value ?? "",
});

export const SchemaVersionProvider = () =>
  Provider.succeed(SchemaVersion, {
    stables: ["version", "schema", "resourceGroup", "schemaVersionId"],

    // Versions vanish with their schema.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const moved =
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.schema.toLowerCase() !== output.schema.toLowerCase() ||
        news.version !== output.version;
      if (moved || news.value !== output.value) {
        // Same name, new payload: the old version must go first.
        return { action: "replace", deleteFirst: !moved } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const schema = output?.schema ?? olds?.schema;
      const version = output?.version ?? olds?.version;
      if (
        resourceGroup === undefined ||
        schema === undefined ||
        version === undefined
      ) {
        return undefined;
      }
      const observed = yield* getVersion(
        subscriptionId,
        resourceGroup,
        schema,
        version,
      );
      return observed === undefined
        ? undefined
        : toAttrs(resourceGroup, schema, version, observed);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Edge");
      const { resourceGroup, schema, version } = news;
      const get = getVersion(subscriptionId, resourceGroup, schema, version);

      // Observe.
      const observed = yield* get;

      // Ensure. The payload is the version's only aspect.
      if (observed === undefined || observed.properties?.value !== news.value) {
        yield* edge.SchemaVersionsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          schemaName: schema,
          schemaVersionName: version,
          properties: { value: news.value },
        });
      }

      const fresh = yield* waitForProvisioned(
        `edge schema version ${schema}/${version}`,
        get,
        edgeState,
        EDGE_WAIT,
      );
      return toAttrs(resourceGroup, schema, version, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        edge.DeleteSchemaVersion({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          schemaName: output.schema,
          schemaVersionName: output.version,
        }),
      );
      yield* waitUntilGone(
        `edge schema version ${output.schema}/${output.version}`,
        getVersion(
          subscriptionId,
          output.resourceGroup,
          output.schema,
          output.version,
        ),
        EDGE_WAIT,
      );
    }),
  });
