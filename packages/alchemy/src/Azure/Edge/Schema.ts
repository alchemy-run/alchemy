import * as edge from "@distilled.cloud/azure/edge";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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
import { EDGE_WAIT, edgeState } from "./EdgeShared.ts";

export interface SchemaProps {
  /** Resource group the schema is created in. Changing it replaces the schema. */
  resourceGroup: string;
  /**
   * Name of the schema. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the schema.
   */
  name?: string;
  /**
   * Azure location of the schema. Workload orchestration is available in
   * `eastus` and `eastus2`. Changing it replaces the schema.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Schema extends Resource<
  "Azure.Edge.Schema",
  SchemaProps,
  {
    /** Name of the schema. */
    schemaName: string;
    /** Resource group that holds the schema. */
    resourceGroup: string;
    /** ARM resource ID of the schema. */
    schemaId: string;
    /** Location of the schema. */
    location: string;
    /** Latest published version of the schema, if any. */
    currentVersion: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Arc workload orchestration schema. A schema declares the
 * configuration keys (type, required, who may edit them) that solution and
 * configuration templates validate against. The rules themselves live in
 * immutable `Azure.Edge.SchemaVersion` children.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/workload-orchestration/configuration-model
 *
 * ### Creating a Schema
 * **Example:** Schema with a version
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("edge", {
 *   location: "eastus",
 * });
 * const schema = yield* Azure.Edge.Schema("app", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.Edge.SchemaVersion("app-v1", {
 *   resourceGroup: group.resourceGroupName,
 *   schema: schema.schemaName,
 *   version: "1.0.0",
 *   value: [
 *     "rules:",
 *     "  configs:",
 *     "    AppName:",
 *     "      type: string",
 *     "      required: true",
 *   ].join("\n"),
 * });
 * ```
 *
 * @resource
 */
export const Schema = Resource<Schema>("Azure.Edge.Schema");

const getSchema = (
  subscriptionId: string,
  resourceGroupName: string,
  schemaName: string,
) =>
  orUndefinedIfNotFound(
    edge.GetSchema({ subscriptionId, resourceGroupName, schemaName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  schema: edge.GetSchemaResponse,
): Schema["Attributes"] => ({
  schemaName: name,
  resourceGroup,
  schemaId: schema.id ?? "",
  location: schema.location,
  currentVersion: schema.properties?.currentVersion,
  tags: userTags(schema.tags),
});

const schemaName = (id: string) => createPhysicalName({ id, maxLength: 63 });

export const SchemaProvider = () =>
  Provider.succeed(Schema, {
    stables: ["schemaName", "resourceGroup", "schemaId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* edge
        .ListSchemaBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListSchemaBySubscription", page),
          ),
        );
      return page.value.flatMap((schema) => {
        const group = resourceGroupOf(schema.id);
        return hasAnyAlchemyTag(schema.tags) &&
          group !== undefined &&
          schema.name !== undefined
          ? [toAttrs(group, schema.name, schema)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.schemaName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.toLowerCase() !== output.location.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.schemaName ?? olds?.name ?? (yield* schemaName(id));
      const observed = yield* getSchema(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Edge");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.schemaName ?? (yield* schemaName(id));
      const tags = yield* desiredTags(id, news.tags);
      const get = getSchema(subscriptionId, resourceGroup, name);

      // Observe.
      const observed = yield* get;

      // Ensure, then sync tags (the schema's only mutable aspect).
      if (observed === undefined) {
        yield* edge.SchemasCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          schemaName: name,
          location: news.location ?? output?.location ?? env.location,
          tags,
          properties: {},
        });
      } else if (tagsDiffer(observed.tags, tags)) {
        yield* edge.UpdateSchema({
          subscriptionId,
          resourceGroupName: resourceGroup,
          schemaName: name,
          tags,
        });
      }

      const fresh = yield* waitForProvisioned(
        `edge schema ${name}`,
        get,
        edgeState,
        EDGE_WAIT,
      );
      return toAttrs(resourceGroup, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        edge.DeleteSchema({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          schemaName: output.schemaName,
        }),
      );
      yield* waitUntilGone(
        `edge schema ${output.schemaName}`,
        getSchema(subscriptionId, output.resourceGroup, output.schemaName),
        EDGE_WAIT,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
