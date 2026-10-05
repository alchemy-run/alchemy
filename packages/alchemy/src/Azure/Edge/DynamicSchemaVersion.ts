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

export interface DynamicSchemaVersionProps {
  /** Resource group of the schema. Changing it replaces the version. */
  resourceGroup: string;
  /** Name of the schema that holds the dynamic schema. Changing it replaces the version. */
  schema: string;
  /** Name of the parent dynamic schema. Changing it replaces the version. */
  dynamicSchema: string;
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

export interface DynamicSchemaVersion extends Resource<
  "Azure.Edge.DynamicSchemaVersion",
  DynamicSchemaVersionProps,
  {
    /** Version name. */
    version: string;
    /** Name of the schema that holds the dynamic schema. */
    schema: string;
    /** Name of the parent dynamic schema. */
    dynamicSchema: string;
    /** Resource group of the schema. */
    resourceGroup: string;
    /** ARM resource ID of the version. */
    dynamicSchemaVersionId: string;
    /** Schema rules YAML. */
    value: string;
  },
  never,
  Providers
> {}

/**
 * An immutable version of an Azure Arc workload orchestration dynamic
 * schema.
 *
 * Versions carry no tags or free-form fields, so Alchemy cannot mark them;
 * a version found under the expected name is treated as this resource.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/workload-orchestration/configuration-model
 *
 * ### Publishing a Version
 * **Example:** Dynamic schema rules
 * ```typescript
 * yield* Azure.Edge.DynamicSchemaVersion("dynamic-v1", {
 *   resourceGroup: group.resourceGroupName,
 *   schema: schema.schemaName,
 *   dynamicSchema: dynamic.dynamicSchemaName,
 *   version: "1.0.0",
 *   value: "rules:\n  configs:\n    Greeting:\n      type: string\n",
 * });
 * ```
 *
 * @resource
 */
export const DynamicSchemaVersion = Resource<DynamicSchemaVersion>(
  "Azure.Edge.DynamicSchemaVersion",
);

interface Where {
  readonly resourceGroup: string;
  readonly schema: string;
  readonly dynamicSchema: string;
  readonly version: string;
}

const request = (subscriptionId: string, where: Where) => ({
  subscriptionId,
  resourceGroupName: where.resourceGroup,
  schemaName: where.schema,
  dynamicSchemaName: where.dynamicSchema,
  dynamicSchemaVersionName: where.version,
});

const getVersion = (subscriptionId: string, where: Where) =>
  orUndefinedIfNotFound(
    edge.GetDynamicSchemaVersion(request(subscriptionId, where)),
  );

const toAttrs = (
  where: Where,
  observed: edge.GetDynamicSchemaVersionResponse,
): DynamicSchemaVersion["Attributes"] => ({
  version: where.version,
  schema: where.schema,
  dynamicSchema: where.dynamicSchema,
  resourceGroup: where.resourceGroup,
  dynamicSchemaVersionId: observed.id ?? "",
  value: observed.properties?.value ?? "",
});

const label = (where: Where) =>
  `edge dynamic schema version ${where.schema}/${where.dynamicSchema}/${where.version}`;

export const DynamicSchemaVersionProvider = () =>
  Provider.succeed(DynamicSchemaVersion, {
    stables: [
      "version",
      "schema",
      "dynamicSchema",
      "resourceGroup",
      "dynamicSchemaVersionId",
    ],

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
        news.dynamicSchema.toLowerCase() !==
          output.dynamicSchema.toLowerCase() ||
        news.version !== output.version;
      if (moved || news.value !== output.value) {
        // Same name, new payload: the old version must go first.
        return { action: "replace", deleteFirst: !moved } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const source = output ?? olds;
      if (
        source?.resourceGroup === undefined ||
        source.schema === undefined ||
        source.dynamicSchema === undefined ||
        source.version === undefined
      ) {
        return undefined;
      }
      const where = {
        resourceGroup: source.resourceGroup,
        schema: source.schema,
        dynamicSchema: source.dynamicSchema,
        version: source.version,
      };
      const observed = yield* getVersion(subscriptionId, where);
      return observed === undefined ? undefined : toAttrs(where, observed);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Edge");
      const get = getVersion(subscriptionId, news);

      // Observe.
      const observed = yield* get;

      // Ensure. The payload is the version's only aspect.
      if (observed === undefined || observed.properties?.value !== news.value) {
        yield* edge.DynamicSchemaVersionsCreateOrUpdate({
          ...request(subscriptionId, news),
          properties: { value: news.value },
        });
      }

      const fresh = yield* waitForProvisioned(
        label(news),
        get,
        edgeState,
        EDGE_WAIT,
      );
      return toAttrs(news, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        edge.DeleteDynamicSchemaVersion(request(subscriptionId, output)),
      );
      yield* waitUntilGone(
        label(output),
        getVersion(subscriptionId, output),
        EDGE_WAIT,
      );
    }),
  });
