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
  expandName,
  hasOwnershipMarker,
  listAgents,
  listEntityTypes,
  normalizeLocation,
  ownedByAlchemy,
  ownershipLabels,
  ownershipText,
  parseOwnership,
  parseResourceName,
  sameJson,
  sameText,
  updateMaskOf,
} from "./internal.ts";

export type EntityTypeKind =
  | "KIND_UNSPECIFIED"
  | "KIND_MAP"
  | "KIND_LIST"
  | "KIND_REGEXP"
  | (string & {});

export type EntityTypeEntity = {
  /** Canonical entity value. */
  value: string;
  /** Synonyms that map onto `value`. */
  synonyms?: string[];
};

export type AgentsEntityTypeProps = {
  /**
   * Parent agent resource name
   * `projects/{project}/locations/{location}/agents/{agent}`. Immutable —
   * changing it replaces the entity type.
   */
  agent: string;
  /**
   * Entity type id (the `{entity_type}` segment). Server-assigned on
   * create. Immutable — changing it replaces the entity type.
   */
  entityTypeId?: string;
  /**
   * Location used when `agent` is a bare id.
   * @default "us-central1"
   */
  location?: string;
  /**
   * Human-readable name, unique within the agent. Entity types have no
   * labels field, so Alchemy stamps ownership into this field for
   * `list` / nuke.
   */
  displayName?: string;
  /**
   * Entity kind.
   * @default "KIND_MAP"
   */
  kind?: EntityTypeKind;
  /** Canonical values and synonyms. Required for `KIND_MAP`. */
  entities?: EntityTypeEntity[];
  /** Phrases excluded from classification. */
  excludedPhrases?: Array<{ value: string }>;
  /**
   * Auto-expansion mode.
   * @default "AUTO_EXPANSION_MODE_UNSPECIFIED"
   */
  autoExpansionMode?:
    | "AUTO_EXPANSION_MODE_UNSPECIFIED"
    | "AUTO_EXPANSION_MODE_DEFAULT"
    | (string & {});
  /**
   * Enable fuzzy extraction.
   * @default false
   */
  enableFuzzyExtraction?: boolean;
  /**
   * Redact entity values in logs.
   * @default false
   */
  redact?: boolean;
  /** Language code of the entity type. */
  languageCode?: string;
};

export type AgentsEntityType = Resource<
  "GCP.Dialogflow.AgentsEntityType",
  AgentsEntityTypeProps,
  {
    /** Full resource name. */
    name: string;
    /** Entity type id (last path segment). */
    entityTypeId: string;
    /** Parent agent resource name. */
    agent: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Entity kind. */
    kind: string | undefined;
    /** Canonical values and synonyms. */
    entities: EntityTypeEntity[];
    /** Excluded phrases. */
    excludedPhrases: Array<{ value: string }>;
    /** Auto-expansion mode. */
    autoExpansionMode: string | undefined;
    /** Whether fuzzy extraction is enabled. */
    enableFuzzyExtraction: boolean;
    /** Whether values are redacted in logs. */
    redact: boolean;
  },
  never,
  Providers
>;

/**
 * A Dialogflow CX entity type under an agent.
 *
 * Entity types have no labels field, so Alchemy stamps ownership into
 * `displayName` for `list` / nuke. Parent agent and entity type id are
 * immutable. Display name, kind, entities, and extraction flags update
 * in place.
 *
 * ### Creating an Entity Type
 * **Example:** Map entity type
 * ```typescript
 * const color = yield* GCP.Dialogflow.AgentsEntityType("Color", {
 *   agent: agent.name,
 *   displayName: "color",
 *   kind: "KIND_MAP",
 *   entities: [{ value: "red", synonyms: ["red", "scarlet"] }],
 * });
 * ```
 *
 * ### Updating an Entity Type
 * **Example:** Add a synonym
 * ```typescript
 * const color = yield* GCP.Dialogflow.AgentsEntityType("Color", {
 *   agent: agent.name,
 *   entityTypeId: existing.entityTypeId,
 *   displayName: "color",
 *   kind: "KIND_MAP",
 *   entities: [
 *     { value: "red", synonyms: ["red", "scarlet", "crimson"] },
 *   ],
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Dialogflow
 */
export const AgentsEntityType = Resource<AgentsEntityType>(
  "GCP.Dialogflow.AgentsEntityType",
);

export class AgentsEntityTypeNotResolved extends Data.TaggedError(
  "GCP.Dialogflow.AgentsEntityTypeNotResolved",
)<{
  name: string;
}> {}

const entitiesOf = (
  list:
    | readonly dialogflow.GoogleCloudDialogflowCxV3EntityTypeEntity[]
    | undefined,
): EntityTypeEntity[] =>
  (list ?? [])
    .filter((entity) => (entity.value ?? "").length > 0)
    .map((entity) => ({
      value: entity.value ?? "",
      synonyms: [...(entity.synonyms ?? [])],
    }));

const excludedOf = (
  list:
    | readonly dialogflow.GoogleCloudDialogflowCxV3EntityTypeExcludedPhrase[]
    | undefined,
): Array<{ value: string }> =>
  (list ?? [])
    .filter((phrase) => (phrase.value ?? "").length > 0)
    .map((phrase) => ({ value: phrase.value ?? "" }));

const toAttrs = (
  entityType: dialogflow.GoogleCloudDialogflowCxV3EntityType,
  project: string,
) => {
  const name = entityType.name ?? "";
  const parsed = parseResourceName(name, "entityTypes");
  return {
    name,
    entityTypeId: parsed.id,
    agent: parsed.agent,
    project: parsed.project || project,
    location: parsed.location,
    displayName: parseOwnership(entityType.displayName).text,
    kind: entityType.kind,
    entities: entitiesOf(entityType.entities),
    excludedPhrases: excludedOf(entityType.excludedPhrases),
    autoExpansionMode: entityType.autoExpansionMode,
    enableFuzzyExtraction: entityType.enableFuzzyExtraction === true,
    redact: entityType.redact === true,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dialogflow
        .getProjectsLocationsAgentsEntityTypes({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findOwned = (id: string, agent: string, hinted?: string) =>
  Effect.gen(function* () {
    if (hinted !== undefined && hinted.length > 0) {
      const existing = yield* getByName(hinted);
      if (existing !== undefined) return existing;
    }
    const entityTypes = yield* listEntityTypes(agent);
    for (const entityType of entityTypes) {
      if (yield* ownedByAlchemy(id, ownershipText(entityType))) {
        return entityType;
      }
    }
    return undefined as
      | dialogflow.GoogleCloudDialogflowCxV3EntityType
      | undefined;
  });

export const AgentsEntityTypeProvider = () =>
  Provider.succeed(AgentsEntityType, {
    stables: ["name", "entityTypeId", "agent", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousAgent = olds?.agent ?? output?.agent;
      const previousId = olds?.entityTypeId ?? output?.entityTypeId;
      if (
        (previousAgent !== undefined && news.agent !== previousAgent) ||
        (previousId !== undefined &&
          news.entityTypeId !== undefined &&
          news.entityTypeId !== previousId)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousAgent === news.agent &&
            previousId !== undefined &&
            news.entityTypeId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const agent = olds?.agent ?? output?.agent;
      const existing =
        output?.name !== undefined
          ? yield* getByName(output.name)
          : agent !== undefined
            ? yield* findOwned(id, agent)
            : undefined;
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, ownershipText(existing)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const agents = yield* listAgents(env.project);
        const pages = yield* Effect.forEach(
          agents,
          (agent) =>
            agent.name
              ? listEntityTypes(agent.name).pipe(
                  Effect.map((entityTypes) =>
                    entityTypes
                      .filter((entityType) =>
                        hasOwnershipMarker(entityType.displayName),
                      )
                      .map((entityType) => toAttrs(entityType, env.project)),
                  ),
                )
              : Effect.succeed([]),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location);
      const agent = expandName(news.agent, env.project, location, "agents");
      const ownership = yield* ownershipLabels(id);
      const displayName = encodeOwnershipLine(
        ownership,
        news.displayName ?? "entity",
      );
      const kind = news.kind ?? "KIND_MAP";
      const entities = news.entities;
      const excludedPhrases = news.excludedPhrases;
      const autoExpansionMode = news.autoExpansionMode;
      const enableFuzzyExtraction = news.enableFuzzyExtraction === true;
      const redact = news.redact === true;
      const body: dialogflow.GoogleCloudDialogflowCxV3EntityType = {
        displayName,
        kind,
        entities,
        excludedPhrases,
        autoExpansionMode,
        enableFuzzyExtraction,
        redact,
      };

      let current = yield* findOwned(id, agent, output?.name);

      if (current === undefined) {
        const created = yield* dialogflow
          .createProjectsLocationsAgentsEntityTypes({
            parent: agent,
            languageCode: news.languageCode,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwned(id, agent, output?.name),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        const name =
          output?.name ??
          (news.entityTypeId
            ? `${agent}/entityTypes/${news.entityTypeId}`
            : agent);
        return yield* new AgentsEntityTypeNotResolved({ name });
      }

      const currentName = current.name ?? output?.name ?? "";
      const displayChanged = !sameText(current.displayName, displayName);
      const kindChanged = !sameText(current.kind, kind);
      const entitiesChanged = !sameJson(
        entitiesOf(current.entities),
        entitiesOf(entities),
      );
      const excludedChanged = !sameJson(
        excludedOf(current.excludedPhrases),
        excludedOf(excludedPhrases),
      );
      const expansionChanged = !sameText(
        current.autoExpansionMode,
        autoExpansionMode,
      );
      const fuzzyChanged =
        (current.enableFuzzyExtraction === true) !== enableFuzzyExtraction;
      const redactChanged = (current.redact === true) !== redact;

      if (
        displayChanged ||
        kindChanged ||
        entitiesChanged ||
        excludedChanged ||
        expansionChanged ||
        fuzzyChanged ||
        redactChanged
      ) {
        current = yield* dialogflow.patchProjectsLocationsAgentsEntityTypes({
          name: currentName,
          languageCode: news.languageCode,
          updateMask: updateMaskOf(
            displayChanged ? "display_name" : undefined,
            kindChanged ? "kind" : undefined,
            entitiesChanged ? "entities" : undefined,
            excludedChanged ? "excluded_phrases" : undefined,
            expansionChanged ? "auto_expansion_mode" : undefined,
            fuzzyChanged ? "enable_fuzzy_extraction" : undefined,
            redactChanged ? "redact" : undefined,
          ),
          body: { ...body, name: currentName },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dialogflow
        .deleteProjectsLocationsAgentsEntityTypes({
          name: output.name,
          force: true,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
