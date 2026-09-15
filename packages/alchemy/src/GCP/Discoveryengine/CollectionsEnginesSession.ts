import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnership,
  hasOwnershipMarker,
  listEngines,
  ownershipLabels,
  parentBefore,
  parseOwnership,
  parseResourceName,
  sameStringList,
  toResourceId,
} from "./internal.ts";

export type CollectionsEnginesSessionProps = {
  /**
   * Parent Engine resource name
   * `projects/{project}/locations/{location}/collections/{collection}/engines/{engine}`.
   * Immutable — changing it replaces the session.
   */
  engine: string;
  /**
   * Session id. If omitted, a unique id is generated. Immutable —
   * changing it replaces the session.
   */
  sessionId?: string;
  /**
   * User-facing display name. Sessions have a string-list `labels`
   * field; Alchemy also stamps ownership into `displayName` for list /
   * nuke.
   */
  displayName?: string;
  /**
   * User tracking id.
   */
  userPseudoId?: string;
  /**
   * Session state.
   */
  state?: discoveryengine.GoogleCloudDiscoveryengineV1SessionStateEnum;
  /**
   * Pin the session to the top of the session list.
   * @default false
   */
  isPinned?: boolean;
  /**
   * Free-form session labels.
   */
  labels?: string[];
};

export type CollectionsEnginesSession = Resource<
  "GCP.Discoveryengine.CollectionsEnginesSession",
  CollectionsEnginesSessionProps,
  {
    /** Full resource name. */
    name: string;
    /** Session id (last path segment). */
    sessionId: string;
    /** Parent engine resource name. */
    engine: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Collection id. */
    collectionId: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** User tracking id. */
    userPseudoId: string | undefined;
    /** Session state. */
    state: string | undefined;
    /** Whether the session is pinned. */
    isPinned: boolean;
    /** User labels (Alchemy ownership strings stripped). */
    labels: string[];
    /** RFC3339 start timestamp. */
    startTime: string | undefined;
    /** RFC3339 end timestamp. */
    endTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Discovery Engine Session on a collection Engine.
 *
 * Alchemy stamps ownership into `displayName` for `list` / nuke. Parent
 * engine and session id are immutable; display name, pin, and labels
 * update in place.
 *
 * ### Creating a Session
 * **Example:** Named session
 * ```typescript
 * const session = yield* GCP.Discoveryengine.CollectionsEnginesSession(
 *   "Chat",
 *   {
 *     engine: engine.name,
 *     displayName: "support",
 *   },
 * );
 * ```
 *
 * ### Updating a Session
 * **Example:** Pin and rename
 * ```typescript
 * const session = yield* GCP.Discoveryengine.CollectionsEnginesSession(
 *   "Chat",
 *   {
 *     engine: existing.engine,
 *     sessionId: existing.sessionId,
 *     displayName: "support-prod",
 *     isPinned: true,
 *   },
 * );
 * ```
 *
 * @resource
 * @product GCP
 * @category Discoveryengine
 */
export const CollectionsEnginesSession = Resource<CollectionsEnginesSession>(
  "GCP.Discoveryengine.CollectionsEnginesSession",
);

export class CollectionsEnginesSessionNotResolved extends Data.TaggedError(
  "GCP.Discoveryengine.CollectionsEnginesSessionNotResolved",
)<{
  name: string;
}> {}

const resourceName = (engine: string, sessionId: string) =>
  `${engine}/sessions/${sessionId}`;

const getByName = (name: string) =>
  discoveryengine
    .getProjectsLocationsCollectionsEnginesSessions({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listByEngine = (engine: string) =>
  discoveryengine.listProjectsLocationsCollectionsEnginesSessions
    .pages({ parent: engine, pageSize: 1000 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.sessions ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
      Effect.catchTag("Forbidden", () => Effect.succeed([])),
    );

const userLabels = (labels: readonly string[] | undefined) =>
  (labels ?? []).filter((label) => !label.startsWith("[alchemy "));

const toAttrs = (
  session: discoveryengine.GoogleCloudDiscoveryengineV1Session,
  project: string,
) => {
  const name = session.name ?? "";
  const parsed = parseResourceName(name, "sessions");
  const ownership = parseOwnership(session.displayName);
  return {
    name,
    sessionId: parsed.id,
    engine: parentBefore(name, "sessions"),
    project: parsed.project || project,
    location: parsed.location,
    collectionId: parsed.collectionId,
    displayName: ownership.text,
    userPseudoId: session.userPseudoId,
    state: session.state,
    isPinned: session.isPinned === true,
    labels: userLabels(session.labels),
    startTime: session.startTime,
    endTime: session.endTime,
  };
};

const findOwned = (id: string, engine: string, hinted?: string) =>
  Effect.gen(function* () {
    if (hinted !== undefined && hinted.length > 0) {
      const existing = yield* getByName(hinted);
      if (existing !== undefined) return existing;
    }
    const items = yield* listByEngine(engine);
    for (const item of items) {
      const { labels } = parseOwnership(item.displayName);
      if (yield* hasAlchemyLabels(id, labels)) return item;
    }
    return undefined as
      | discoveryengine.GoogleCloudDiscoveryengineV1Session
      | undefined;
  });

export const CollectionsEnginesSessionProvider = () =>
  Provider.succeed(CollectionsEnginesSession, {
    stables: [
      "name",
      "sessionId",
      "engine",
      "project",
      "location",
      "collectionId",
      "startTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousEngine = olds?.engine ?? output?.engine;
      const previousId = olds?.sessionId ?? output?.sessionId;
      const nextId = news.sessionId ?? previousId;
      if (
        (previousEngine !== undefined && news.engine !== previousEngine) ||
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const engine = olds?.engine ?? output?.engine;
      const existing =
        output?.name !== undefined
          ? yield* getByName(output.name)
          : engine !== undefined
            ? yield* findOwned(id, engine)
            : undefined;
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseOwnership(existing.displayName);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const engines = yield* listEngines(env.project);
        const rows: ReturnType<typeof toAttrs>[] = [];
        for (const engine of engines) {
          if (engine.name === undefined) continue;
          const items = yield* listByEngine(engine.name);
          for (const item of items) {
            if (hasOwnershipMarker(item.displayName)) {
              rows.push(toAttrs(item, env.project));
            }
          }
        }
        return rows;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const sessionId = yield* toResourceId(
        id,
        news.sessionId,
        output?.sessionId,
      );
      const ownership = yield* ownershipLabels(id);
      const displayName = encodeOwnership(ownership, news.displayName);
      const isPinned = news.isPinned === true;
      const labels = news.labels;
      const fallbackName = output?.name ?? resourceName(news.engine, sessionId);

      let current = yield* findOwned(id, news.engine, output?.name);

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsCollectionsEnginesSessions({
            parent: news.engine,
            sessionId,
            body: {
              displayName,
              userPseudoId: news.userPseudoId,
              state: news.state,
              isPinned: isPinned ? true : undefined,
              labels,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(fallbackName)));
        current = created ?? undefined;
        if (current === undefined) {
          current = yield* findOwned(id, news.engine);
        }
      }

      if (current === undefined) {
        return yield* new CollectionsEnginesSessionNotResolved({
          name: fallbackName,
        });
      }

      const name = current.name ?? fallbackName;
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const userChanged =
        (current.userPseudoId ?? "") !== (news.userPseudoId ?? "");
      const stateChanged = (current.state ?? "") !== (news.state ?? "");
      const pinnedChanged = (current.isPinned === true) !== isPinned;
      const labelsChanged = !sameStringList(userLabels(current.labels), labels);

      if (
        displayNameChanged ||
        userChanged ||
        stateChanged ||
        pinnedChanged ||
        labelsChanged
      ) {
        current =
          yield* discoveryengine.patchProjectsLocationsCollectionsEnginesSessions(
            {
              name,
              updateMask: [
                displayNameChanged ? "display_name" : undefined,
                userChanged ? "user_pseudo_id" : undefined,
                stateChanged ? "state" : undefined,
                pinnedChanged ? "is_pinned" : undefined,
                labelsChanged ? "labels" : undefined,
              ]
                .filter((field): field is string => field !== undefined)
                .join(","),
              body: {
                name,
                displayName,
                userPseudoId: news.userPseudoId,
                state: news.state,
                isPinned,
                labels,
              },
            },
          );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      yield* discoveryengine
        .deleteProjectsLocationsCollectionsEnginesSessions({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
