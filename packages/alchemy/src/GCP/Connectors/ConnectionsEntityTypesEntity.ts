import * as connectors from "@distilled.cloud/gcp/connectors_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LOCATION,
  entityNameOf,
  findOwnedEntity,
  getEntity,
  listOwnedEntities,
  ownedByAlchemy,
  parentOf,
  parseEntityName,
  retryTransient,
  sameJson,
  stampFields,
  userFields,
  type EntityFields,
} from "./internal.ts";

export type ConnectionsEntityTypesEntityProps = {
  /**
   * Parent entity type resource name
   * `projects/{project}/locations/{location}/connections/{connection}/entityTypes/{type}`.
   * Immutable — changing it replaces the entity.
   */
  parent: string;
  /**
   * External-system entity id (the `{id}` segment of
   * `.../entityTypes/{type}/entities/{id}`). Server-assigned on create.
   * Immutable — changing it replaces the entity.
   */
  entityId?: string;
  /**
   * Entity field values sent to the connected system. Keys are field
   * names; values are JSON-compatible. Integration Connectors entities
   * have no labels field, so Alchemy ownership is stored as
   * `alchemy-stack` / `alchemy-stage` / `alchemy-id` fields (stripped
   * from attributes). The entity type must accept these extra fields.
   */
  fields?: EntityFields;
};

export type ConnectionsEntityTypesEntity = Resource<
  "GCP.Connectors.ConnectionsEntityTypesEntity",
  ConnectionsEntityTypesEntityProps,
  {
    /**
     * Full resource name
     * `projects/{project}/locations/{location}/connections/{connection}/entityTypes/{type}/entities/{id}`.
     */
    name: string;
    /** External-system entity id. */
    entityId: string;
    /** Parent entity type resource name. */
    parent: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Connection id. */
    connection: string;
    /** Entity type id. */
    entityType: string;
    /** User fields (Alchemy ownership fields stripped). */
    fields: EntityFields;
  },
  never,
  Providers
>;

/**
 * A row in a connected system, reached through Integration Connectors.
 *
 * Entities live under a Connection entity type. The entity id is
 * assigned by the external system. Parent and entity id are identity —
 * changing either replaces the row. `fields` update in place via patch.
 * Ownership is stamped into `fields` so `list` / nuke can find rows.
 *
 * Creating an entity requires an ACTIVE Integration Connectors
 * connection whose entity type accepts the supplied fields.
 *
 * ### Creating an Entity
 * **Example:** Insert a row
 * ```typescript
 * const account = yield* GCP.Connectors.ConnectionsEntityTypesEntity(
 *   "Account",
 *   {
 *     parent:
 *       "projects/my-project/locations/us-central1/connections/salesforce/entityTypes/Account",
 *     fields: { Name: "Acme" },
 *   },
 * );
 * ```
 *
 * ### Updating an Entity
 * **Example:** Patch fields
 * ```typescript
 * const account = yield* GCP.Connectors.ConnectionsEntityTypesEntity(
 *   "Account",
 *   {
 *     parent: existing.parent,
 *     entityId: existing.entityId,
 *     fields: { Name: "Acme Corp" },
 *   },
 * );
 * ```
 *
 * @resource
 * @product GCP
 * @category Connectors
 */
export const ConnectionsEntityTypesEntity =
  Resource<ConnectionsEntityTypesEntity>(
    "GCP.Connectors.ConnectionsEntityTypesEntity",
  );

export class ConnectionsEntityTypesEntityNotResolved extends Data.TaggedError(
  "GCP.Connectors.ConnectionsEntityTypesEntityNotResolved",
)<{
  parent: string;
  entityId: string;
}> {}

const toAttrs = (
  entity: connectors.Entity,
  project: string,
  parent: string,
) => {
  const name = entity.name ?? "";
  const parsed = parseEntityName(name || `${parent}/entities/`);
  return {
    name,
    entityId: parsed.entityId,
    parent: parsed.parent || parent,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_LOCATION,
    connection: parsed.connection,
    entityType: parsed.entityType,
    fields: userFields(entity.fields),
  };
};

const refresh = (name: string, fallback: connectors.Entity) =>
  getEntity(name).pipe(Effect.map((fresh) => fresh ?? fallback));

export const ConnectionsEntityTypesEntityProvider = () =>
  Provider.succeed(ConnectionsEntityTypesEntity, {
    stables: [
      "name",
      "entityId",
      "parent",
      "project",
      "location",
      "connection",
      "entityType",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.parent ?? output?.parent;
      if (previousParent !== undefined && news.parent !== previousParent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.entityId ?? output?.entityId;
      if (
        previousId !== undefined &&
        news.entityId !== undefined &&
        news.entityId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = olds?.parent ?? output?.parent ?? "";
      const entityId = olds?.entityId ?? output?.entityId;
      const name =
        output?.name ??
        (entityId !== undefined && parent.length > 0
          ? entityNameOf(parent, entityId)
          : "");
      let existing = yield* getEntity(name);
      if (existing === undefined) {
        existing = yield* findOwnedEntity(parent, id);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, parent);
      return (yield* ownedByAlchemy(id, existing.fields))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const entities = yield* listOwnedEntities(env.project);
        return entities.map((entity) =>
          toAttrs(entity, env.project, parentOf(entity.name ?? "")),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = news.parent;
      const ownership = yield* createInternalLabels(id);
      const desiredFields = stampFields(ownership, news.fields);
      const name =
        output?.name ??
        (news.entityId !== undefined
          ? entityNameOf(parent, news.entityId)
          : "");

      let current = yield* getEntity(name);
      if (current === undefined) {
        current = yield* findOwnedEntity(parent, id);
      }

      if (current === undefined) {
        const created = yield* retryTransient(
          connectors.createProjectsLocationsConnectionsEntityTypesEntities({
            parent,
            body: { fields: desiredFields },
          }),
        ).pipe(Effect.catchTag("Conflict", () => findOwnedEntity(parent, id)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ConnectionsEntityTypesEntityNotResolved({
          parent,
          entityId: news.entityId ?? output?.entityId ?? "",
        });
      }

      const currentName = current.name ?? name;
      const fieldsChanged = !sameJson(
        stampFields(ownership, userFields(current.fields)),
        desiredFields,
      );

      if (fieldsChanged && currentName.length > 0) {
        const patched = yield* retryTransient(
          connectors.patchProjectsLocationsConnectionsEntityTypesEntities({
            name: currentName,
            body: { fields: desiredFields },
          }),
        );
        current = yield* refresh(currentName, patched);
      }

      return toAttrs(current, env.project, parent);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.name.length === 0) return;
      yield* retryTransient(
        connectors.deleteProjectsLocationsConnectionsEntityTypesEntities({
          name: output.name,
        }),
      ).pipe(Effect.catchTag(["NotFound", "Forbidden"], () => Effect.void));
    }),
  });
