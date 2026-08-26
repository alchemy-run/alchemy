import * as dialogflow from "@distilled.cloud/gcp/dialogflow_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnershipLine,
  lastSegment,
  listSessionEntityTypes,
  MAX_SESSION_ID_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  parseResourceName,
  sameJson,
  sameText,
  toResourceId,
  updateMaskOf,
} from "./internal.ts";

export type SessionEntity = {
  /** Canonical entity value. */
  value: string;
  /** Synonyms that map onto `value`. */
  synonyms?: string[];
};

export type AgentsEnvironmentsSessionsEntityTypeProps = {
  /**
   * Parent environment resource name
   * `projects/{project}/locations/{location}/agents/{agent}/environments/{environment}`.
   * Immutable — changing it replaces the session entity type.
   */
  environment: string;
  /**
   * Entity type resource name or id. Immutable — changing it replaces
   * the session entity type.
   */
  entityType: string;
  /**
   * Session id (at most 36 bytes). If omitted, a unique id is generated.
   * Immutable — changing it replaces the session entity type. Session
   * entity types have no labels field, so Alchemy stamps ownership into
   * a sentinel entity synonym for `list` / nuke.
   */
  sessionId?: string;
  /**
   * How session entities interact with the custom entity type.
   * @default "ENTITY_OVERRIDE_MODE_OVERRIDE"
   */
  entityOverrideMode?:
    | "ENTITY_OVERRIDE_MODE_UNSPECIFIED"
    | "ENTITY_OVERRIDE_MODE_OVERRIDE"
    | "ENTITY_OVERRIDE_MODE_SUPPLEMENT"
    | (string & {});
  /** Session-scoped entity values. */
  entities: SessionEntity[];
};

export type AgentsEnvironmentsSessionsEntityType = Resource<
  "GCP.Dialogflow.AgentsEnvironmentsSessionsEntityType",
  AgentsEnvironmentsSessionsEntityTypeProps,
  {
    /** Full resource name. */
    name: string;
    /** Entity type id (last path segment). */
    entityTypeId: string;
    /** Parent environment resource name. */
    environment: string;
    /** Session resource name. */
    session: string;
    /** Session id. */
    sessionId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Override mode. */
    entityOverrideMode: string | undefined;
    /** Session-scoped entity values (Alchemy sentinel stripped). */
    entities: SessionEntity[];
  },
  never,
  Providers
>;

/**
 * A Dialogflow CX session entity type under an environment session.
 *
 * Session entity types have no labels or description field, so Alchemy
 * stamps ownership into a sentinel entity value for `list` / nuke.
 * Parent environment, session id, and entity type are immutable.
 * Override mode and entities update in place.
 *
 * ### Creating a Session Entity Type
 * **Example:** Override a color entity for one session
 * ```typescript
 * const session = yield* GCP.Dialogflow.AgentsEnvironmentsSessionsEntityType(
 *   "SessionColor",
 *   {
 *     environment: environment.name,
 *     entityType: color.name,
 *     entityOverrideMode: "ENTITY_OVERRIDE_MODE_OVERRIDE",
 *     entities: [{ value: "blue", synonyms: ["blue", "navy"] }],
 *   },
 * );
 * ```
 *
 * @resource
 * @product GCP
 * @category Dialogflow
 */
export const AgentsEnvironmentsSessionsEntityType =
  Resource<AgentsEnvironmentsSessionsEntityType>(
    "GCP.Dialogflow.AgentsEnvironmentsSessionsEntityType",
  );

export class AgentsEnvironmentsSessionsEntityTypeNotResolved extends Data.TaggedError(
  "GCP.Dialogflow.AgentsEnvironmentsSessionsEntityTypeNotResolved",
)<{
  name: string;
}> {}

const SENTINEL_PREFIX = "__alchemy__";

const entitiesOf = (
  list:
    | readonly dialogflow.GoogleCloudDialogflowCxV3EntityTypeEntity[]
    | undefined,
): SessionEntity[] =>
  (list ?? [])
    .filter((entity) => (entity.value ?? "").length > 0)
    .filter((entity) => !(entity.value ?? "").startsWith(SENTINEL_PREFIX))
    .map((entity) => ({
      value: entity.value ?? "",
      synonyms: [...(entity.synonyms ?? [])],
    }));

const ownershipFromEntities = (
  list:
    | readonly dialogflow.GoogleCloudDialogflowCxV3EntityTypeEntity[]
    | undefined,
) => {
  for (const entity of list ?? []) {
    const value = entity.value ?? "";
    if (value.startsWith(SENTINEL_PREFIX)) {
      const marker = value.slice(SENTINEL_PREFIX.length);
      return parseOwnership(
        marker.startsWith("[alchemy ") ? marker : undefined,
      );
    }
    for (const synonym of entity.synonyms ?? []) {
      if (synonym.startsWith("[alchemy ")) {
        return parseOwnership(synonym);
      }
    }
  }
  return parseOwnership(undefined);
};

const withOwnership = (
  entities: readonly SessionEntity[] | undefined,
  marker: string,
): dialogflow.GoogleCloudDialogflowCxV3EntityTypeEntity[] => [
  ...(entities ?? []).map((entity) => ({
    value: entity.value,
    synonyms: entity.synonyms,
  })),
  {
    value: `${SENTINEL_PREFIX}${marker}`,
    synonyms: [marker],
  },
];

const toAttrs = (
  sessionEntityType: dialogflow.GoogleCloudDialogflowCxV3SessionEntityType,
  project: string,
) => {
  const name = sessionEntityType.name ?? "";
  const parsed = parseResourceName(name, "entityTypes");
  return {
    name,
    entityTypeId: parsed.id,
    environment: parsed.environment,
    session: parsed.session,
    sessionId: parsed.sessionId,
    project: parsed.project || project,
    location: parsed.location,
    entityOverrideMode: sessionEntityType.entityOverrideMode,
    entities: entitiesOf(sessionEntityType.entities),
  };
};

const resourceNameOf = (
  environment: string,
  sessionId: string,
  entityTypeId: string,
) => `${environment}/sessions/${sessionId}/entityTypes/${entityTypeId}`;

const entityTypeIdOf = (entityType: string) => lastSegment(entityType);

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dialogflow
        .getProjectsLocationsAgentsEnvironmentsSessionsEntityTypes({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findOwned = (
  id: string,
  environment: string,
  sessionId: string | undefined,
  entityTypeId: string | undefined,
  hinted?: string,
) =>
  Effect.gen(function* () {
    if (hinted !== undefined && hinted.length > 0) {
      const existing = yield* getByName(hinted);
      if (existing !== undefined) return existing;
    }
    if (sessionId !== undefined && entityTypeId !== undefined) {
      const named = yield* getByName(
        resourceNameOf(environment, sessionId, entityTypeId),
      );
      if (named !== undefined) return named;
    }
    if (sessionId !== undefined) {
      const listed = yield* listSessionEntityTypes(
        `${environment}/sessions/${sessionId}`,
      );
      for (const item of listed) {
        const ownership = ownershipFromEntities(item.entities);
        if (
          yield* ownedByAlchemy(
            id,
            ownership.labels["alchemy-id"]
              ? `[alchemy ${Object.entries(ownership.labels)
                  .map(([key, value]) => `${key}=${value}`)
                  .join(" ")}]`
              : undefined,
          )
        ) {
          return item;
        }
      }
    }
    return undefined as
      | dialogflow.GoogleCloudDialogflowCxV3SessionEntityType
      | undefined;
  });

const listOwned = (_project: string) =>
  Effect.succeed([] as ReturnType<typeof toAttrs>[]);

export const AgentsEnvironmentsSessionsEntityTypeProvider = () =>
  Provider.succeed(AgentsEnvironmentsSessionsEntityType, {
    stables: [
      "name",
      "entityTypeId",
      "environment",
      "session",
      "sessionId",
      "project",
      "location",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.environment ?? output?.environment;
      const previousSession = olds?.sessionId ?? output?.sessionId;
      const previousType = lastSegment(
        olds?.entityType ?? output?.entityTypeId ?? "",
      );
      const nextType = lastSegment(news.entityType);
      if (
        (previousParent !== undefined && news.environment !== previousParent) ||
        (previousSession !== undefined &&
          news.sessionId !== undefined &&
          news.sessionId !== previousSession) ||
        (previousType.length > 0 && nextType !== previousType)
      ) {
        return {
          action: "replace" as const,
          deleteFirst: false,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const existing = yield* findOwned(
        id,
        olds?.environment ?? output?.environment ?? "",
        olds?.sessionId ?? output?.sessionId,
        lastSegment(olds?.entityType ?? output?.entityTypeId ?? ""),
        output?.name,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const ownership = ownershipFromEntities(existing.entities);
      const marker = ownership.labels["alchemy-id"]
        ? `[alchemy ${Object.entries(ownership.labels)
            .map(([key, value]) => `${key}=${value}`)
            .join(" ")}]`
        : undefined;
      return (yield* ownedByAlchemy(id, marker)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listOwned(env.project);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const environment = news.environment;
      const entityTypeId = entityTypeIdOf(news.entityType);
      const sessionId = yield* toResourceId(
        id,
        news.sessionId,
        output?.sessionId,
        MAX_SESSION_ID_LENGTH,
      );
      const name = resourceNameOf(environment, sessionId, entityTypeId);
      const ownership = yield* ownershipLabels(id);
      const marker = encodeOwnershipLine(ownership, undefined, 8000);
      const entityOverrideMode =
        news.entityOverrideMode ?? "ENTITY_OVERRIDE_MODE_OVERRIDE";
      const entities = withOwnership(news.entities, marker);
      const body: dialogflow.GoogleCloudDialogflowCxV3SessionEntityType = {
        name,
        entityOverrideMode,
        entities,
      };

      let current = yield* findOwned(
        id,
        environment,
        sessionId,
        entityTypeId,
        output?.name,
      );

      if (current === undefined) {
        const created = yield* dialogflow
          .createProjectsLocationsAgentsEnvironmentsSessionsEntityTypes({
            parent: `${environment}/sessions/${sessionId}`,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwned(id, environment, sessionId, entityTypeId, name),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AgentsEnvironmentsSessionsEntityTypeNotResolved({
          name,
        });
      }

      const currentName = current.name ?? name;
      const modeChanged = !sameText(
        current.entityOverrideMode,
        entityOverrideMode,
      );
      const entitiesChanged = !sameJson(
        entitiesOf(current.entities),
        entitiesOf(news.entities),
      );
      const ownershipChanged = !sameText(
        ownershipFromEntities(current.entities).labels["alchemy-id"],
        parseOwnership(marker).labels["alchemy-id"],
      );

      if (modeChanged || entitiesChanged || ownershipChanged) {
        current =
          yield* dialogflow.patchProjectsLocationsAgentsEnvironmentsSessionsEntityTypes(
            {
              name: currentName,
              updateMask: updateMaskOf(
                modeChanged ? "entity_override_mode" : undefined,
                entitiesChanged || ownershipChanged ? "entities" : undefined,
              ),
              body: { ...body, name: currentName },
            },
          );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dialogflow
        .deleteProjectsLocationsAgentsEnvironmentsSessionsEntityTypes({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
