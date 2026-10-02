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
import { EDGE_WAIT, edgeState, sameId } from "./EdgeShared.ts";

export interface SchemaReferenceProps {
  /**
   * ARM resource ID of the hierarchy entity (an `Azure.Edge.Site` or
   * target) the reference is attached to. Changing it replaces the
   * reference.
   */
  resourceUri: string;
  /**
   * Name of the reference. Azure expects `default`. Changing it replaces
   * the reference.
   * @default "default"
   */
  name?: string;
  /** ARM resource ID of the `Azure.Edge.Schema` to link. */
  schemaId: string;
}

export interface SchemaReference extends Resource<
  "Azure.Edge.SchemaReference",
  SchemaReferenceProps,
  {
    /** Name of the reference. */
    schemaReferenceName: string;
    /** ARM resource ID of the entity the reference is attached to. */
    resourceUri: string;
    /** ARM resource ID of the reference. */
    schemaReferenceId: string;
    /** ARM resource ID of the linked schema. */
    schemaId: string;
  },
  never,
  Providers
> {}

/**
 * Links an Azure Arc workload orchestration schema to a hierarchy entity
 * (a site or a target). It is an extension resource that lives under the
 * entity's ARM ID.
 *
 * References carry no tags or free-form fields, so Alchemy cannot mark
 * them; one found at the expected scope is treated as this resource.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/workload-orchestration/configuration-model
 *
 * ### Linking a Schema
 * **Example:** Schema for a site
 * ```typescript
 * yield* Azure.Edge.SchemaReference("plant-schema-ref", {
 *   resourceUri: site.siteId,
 *   schemaId: schema.schemaId,
 * });
 * ```
 *
 * @resource
 */
export const SchemaReference = Resource<SchemaReference>(
  "Azure.Edge.SchemaReference",
);

const getReference = (resourceUri: string, schemaReferenceName: string) =>
  orUndefinedIfNotFound(
    edge.GetSchemaReference({ resourceUri, schemaReferenceName }),
  );

const toAttrs = (
  resourceUri: string,
  name: string,
  observed: edge.GetSchemaReferenceResponse,
): SchemaReference["Attributes"] => ({
  schemaReferenceName: name,
  resourceUri,
  schemaReferenceId: observed.id ?? "",
  schemaId: observed.properties?.schemaId ?? "",
});

export const SchemaReferenceProvider = () =>
  Provider.succeed(SchemaReference, {
    stables: ["schemaReferenceName", "resourceUri", "schemaReferenceId"],

    // Extension resources vanish with the entity they extend.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceUri, output.resourceUri) ||
        (news.name ?? "default").toLowerCase() !==
          output.schemaReferenceName.toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const resourceUri = output?.resourceUri ?? olds?.resourceUri;
      if (resourceUri === undefined) return undefined;
      const name = output?.schemaReferenceName ?? olds?.name ?? "default";
      const observed = yield* getReference(resourceUri, name);
      return observed === undefined
        ? undefined
        : toAttrs(resourceUri, name, observed);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Edge");
      const { resourceUri } = news;
      const name = news.name ?? "default";
      const get = getReference(resourceUri, name);

      // Observe.
      const observed = yield* get;

      // Ensure, then sync the linked schema against observed state.
      if (observed === undefined) {
        yield* edge.SchemaReferencesCreateOrUpdate({
          resourceUri,
          schemaReferenceName: name,
          properties: { schemaId: news.schemaId },
        });
      } else if (!sameId(observed.properties?.schemaId, news.schemaId)) {
        yield* edge.UpdateSchemaReference({
          resourceUri,
          schemaReferenceName: name,
          properties: { schemaId: news.schemaId },
        });
      }

      const fresh = yield* waitForProvisioned(
        `edge schema reference ${resourceUri}/${name}`,
        get,
        edgeState,
        EDGE_WAIT,
      );
      return toAttrs(resourceUri, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        edge.DeleteSchemaReference({
          resourceUri: output.resourceUri,
          schemaReferenceName: output.schemaReferenceName,
        }),
      );
      yield* waitUntilGone(
        `edge schema reference ${output.resourceUri}/${output.schemaReferenceName}`,
        getReference(output.resourceUri, output.schemaReferenceName),
        EDGE_WAIT,
      );
    }),
  });
