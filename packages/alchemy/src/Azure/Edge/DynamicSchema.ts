import * as edge from "@distilled.cloud/azure/edge";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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

export interface DynamicSchemaProps {
  /** Resource group of the schema. Changing it replaces the dynamic schema. */
  resourceGroup: string;
  /** Name of the parent schema. Changing it replaces the dynamic schema. */
  schema: string;
  /**
   * Name of the dynamic schema. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the dynamic
   * schema.
   */
  name?: string;
}

export interface DynamicSchema extends Resource<
  "Azure.Edge.DynamicSchema",
  DynamicSchemaProps,
  {
    /** Name of the dynamic schema. */
    dynamicSchemaName: string;
    /** Name of the parent schema. */
    schema: string;
    /** Resource group of the schema. */
    resourceGroup: string;
    /** ARM resource ID of the dynamic schema. */
    dynamicSchemaId: string;
    /** Configuration type reported by the service. */
    configurationType: string | undefined;
    /** Configuration model reported by the service. */
    configurationModel: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A dynamic schema under an Azure Arc workload orchestration schema. Its
 * rules live in immutable `Azure.Edge.DynamicSchemaVersion` children.
 *
 * Dynamic schemas carry no tags or free-form fields, so Alchemy cannot
 * mark them; one found under the expected name is treated as this
 * resource.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/workload-orchestration/configuration-model
 *
 * ### Creating a Dynamic Schema
 * **Example:** Dynamic schema with a version
 * ```typescript
 * const dynamic = yield* Azure.Edge.DynamicSchema("dynamic", {
 *   resourceGroup: group.resourceGroupName,
 *   schema: schema.schemaName,
 * });
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
export const DynamicSchema = Resource<DynamicSchema>(
  "Azure.Edge.DynamicSchema",
);

const getDynamicSchema = (
  subscriptionId: string,
  resourceGroupName: string,
  schemaName: string,
  dynamicSchemaName: string,
) =>
  orUndefinedIfNotFound(
    edge.GetDynamicSchema({
      subscriptionId,
      resourceGroupName,
      schemaName,
      dynamicSchemaName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  schema: string,
  name: string,
  observed: edge.GetDynamicSchemaResponse,
): DynamicSchema["Attributes"] => ({
  dynamicSchemaName: name,
  schema,
  resourceGroup,
  dynamicSchemaId: observed.id ?? "",
  configurationType: observed.properties?.configurationType,
  configurationModel: observed.properties?.configurationModel,
});

const dynamicSchemaName = (id: string) =>
  createPhysicalName({ id, maxLength: 63 });

export const DynamicSchemaProvider = () =>
  Provider.succeed(DynamicSchema, {
    stables: [
      "dynamicSchemaName",
      "schema",
      "resourceGroup",
      "dynamicSchemaId",
    ],

    // Dynamic schemas vanish with their schema.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.schema.toLowerCase() !== output.schema.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.dynamicSchemaName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const schema = output?.schema ?? olds?.schema;
      if (resourceGroup === undefined || schema === undefined) return undefined;
      const name =
        output?.dynamicSchemaName ??
        olds?.name ??
        (yield* dynamicSchemaName(id));
      const observed = yield* getDynamicSchema(
        subscriptionId,
        resourceGroup,
        schema,
        name,
      );
      return observed === undefined
        ? undefined
        : toAttrs(resourceGroup, schema, name, observed);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Edge");
      const { resourceGroup, schema } = news;
      const name =
        news.name ??
        output?.dynamicSchemaName ??
        (yield* dynamicSchemaName(id));
      const get = getDynamicSchema(subscriptionId, resourceGroup, schema, name);

      // Observe, then ensure. A dynamic schema has no mutable aspects.
      if ((yield* get) === undefined) {
        yield* edge.DynamicSchemasCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          schemaName: schema,
          dynamicSchemaName: name,
          properties: {},
        });
      }

      const fresh = yield* waitForProvisioned(
        `edge dynamic schema ${schema}/${name}`,
        get,
        edgeState,
        EDGE_WAIT,
      );
      return toAttrs(resourceGroup, schema, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        edge.DeleteDynamicSchema({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          schemaName: output.schema,
          dynamicSchemaName: output.dynamicSchemaName,
        }),
      );
      yield* waitUntilGone(
        `edge dynamic schema ${output.schema}/${output.dynamicSchemaName}`,
        getDynamicSchema(
          subscriptionId,
          output.resourceGroup,
          output.schema,
          output.dynamicSchemaName,
        ),
        EDGE_WAIT,
      );
    }),
  });
