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
  encodeOwnershipLine,
  labelsFromList,
  listFromLabels,
  listProjectDataStores,
  ownedByAlchemy,
  ownershipLabels,
  parentOf,
  parseOwnership,
  parseResourceName,
  sessionIdOf,
  toPhysical,
  userLabelList,
} from "./internal.ts";

export type CollectionsDataStoresSessionProps = {
  /**
   * Parent data store resource name. Immutable — changing it replaces
   * the session.
   */
  dataStore: string;
  /**
   * Session id (`[a-z0-9]`, 1-63 characters). If omitted, a unique id is
   * generated. Immutable — changing it replaces the session.
   */
  sessionId?: string;
  /**
   * Display name used in the UI (max 128 characters).
   */
  displayName?: string;
  /**
   * Session state.
   * @default "IN_PROGRESS"
   */
  state?: "STATE_UNSPECIFIED" | "IN_PROGRESS" | (string & {});
  /**
   * End-user id.
   */
  userPseudoId?: string;
  /**
   * Session labels. Alchemy ownership labels (`alchemy-stack=…`) are
   * merged in automatically.
   */
  labels?: string[];
  /**
   * Pin the session to the top of the session list.
   * @default false
   */
  isPinned?: boolean;
};

export type CollectionsDataStoresSession = Resource<
  "GCP.Discoveryengine.CollectionsDataStoresSession",
  CollectionsDataStoresSessionProps,
  {
    /** Full resource name. */
    name: string;
    /** Session id. */
    sessionId: string;
    /** Parent data store resource name. */
    dataStore: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Session state. */
    state: string | undefined;
    /** End-user id. */
    userPseudoId: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: string[];
    /** Whether the session is pinned. */
    isPinned: boolean;
    /** RFC3339 start time. */
    startTime: string | undefined;
    /** RFC3339 end time. */
    endTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Discovery Engine session on a collection data store.
 *
 * Sessions accept a string-list `labels` field; Alchemy merges
 * `alchemy-stack` / `alchemy-stage` / `alchemy-id` entries so `list` /
 * nuke can find the session. Display name is also stamped. Parent and
 * session id are immutable.
 *
 * ### Creating a Session
 * **Example:** Pinned session
 * ```typescript
 * const store = yield* GCP.Discoveryengine.CollectionsDataStore("Docs", {});
 * const session = yield* GCP.Discoveryengine.CollectionsDataStoresSession(
 *   "Chat",
 *   {
 *     dataStore: store.name,
 *     displayName: "support chat",
 *     isPinned: true,
 *   },
 * );
 * ```
 *
 * @resource
 * @product GCP
 * @category Discoveryengine
 */
export const CollectionsDataStoresSession =
  Resource<CollectionsDataStoresSession>(
    "GCP.Discoveryengine.CollectionsDataStoresSession",
  );

export class CollectionsDataStoresSessionNotResolved extends Data.TaggedError(
  "GCP.Discoveryengine.CollectionsDataStoresSessionNotResolved",
)<{
  name: string;
}> {}

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
    dataStore: parentOf(name, "sessions"),
    project: parsed.project || project,
    location: parsed.location,
    displayName: ownership.text,
    state: session.state,
    userPseudoId: session.userPseudoId,
    labels: userLabelList(session.labels),
    isPinned: session.isPinned === true,
    startTime: session.startTime,
    endTime: session.endTime,
  };
};

const resourceName = (dataStore: string, sessionId: string) =>
  `${dataStore}/sessions/${sessionId}`;

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : discoveryengine
        .getProjectsLocationsCollectionsDataStoresSessions({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAtParent = (parent: string) =>
  discoveryengine.listProjectsLocationsCollectionsDataStoresSessions
    .pages({ parent, pageSize: 1000 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.sessions ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
      Effect.catchTag("Forbidden", () => Effect.succeed([])),
    );

const findOwned = (id: string, dataStore: string, hinted?: string) =>
  Effect.gen(function* () {
    if (hinted !== undefined && hinted.length > 0) {
      const existing = yield* getByName(hinted);
      if (existing !== undefined) return existing;
    }
    const sessions = yield* listAtParent(dataStore);
    for (const session of sessions) {
      const fromLabels = labelsFromList(session.labels);
      if (yield* hasAlchemyLabels(id, fromLabels)) return session;
      if (yield* ownedByAlchemy(id, session.displayName)) return session;
    }
    return undefined as
      | discoveryengine.GoogleCloudDiscoveryengineV1Session
      | undefined;
  });

export const CollectionsDataStoresSessionProvider = () =>
  Provider.succeed(CollectionsDataStoresSession, {
    stables: [
      "name",
      "sessionId",
      "dataStore",
      "project",
      "location",
      "startTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.dataStore ?? output?.dataStore;
      const previousId = olds?.sessionId ?? output?.sessionId;
      if (
        (previousParent !== undefined && news.dataStore !== previousParent) ||
        (previousId !== undefined &&
          news.sessionId !== undefined &&
          news.sessionId !== previousId)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousParent === news.dataStore &&
            previousId !== undefined &&
            news.sessionId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const dataStore = olds?.dataStore ?? output?.dataStore;
      const existing =
        output?.name !== undefined
          ? yield* getByName(output.name)
          : dataStore !== undefined
            ? yield* findOwned(id, dataStore)
            : undefined;
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const fromLabels = labelsFromList(existing.labels);
      const owned =
        (yield* hasAlchemyLabels(id, fromLabels)) ||
        (yield* ownedByAlchemy(id, existing.displayName));
      return owned ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const stores = yield* listProjectDataStores(env.project);
        const pages = yield* Effect.forEach(
          stores,
          (store) =>
            store.name
              ? listAtParent(store.name).pipe(
                  Effect.map((sessions) =>
                    sessions
                      .filter((session) => {
                        const fromLabels = labelsFromList(session.labels);
                        return (
                          Object.keys(fromLabels).some((key) =>
                            key.startsWith("alchemy-"),
                          ) ||
                          Object.keys(
                            parseOwnership(session.displayName).labels,
                          ).length > 0
                        );
                      })
                      .map((session) => toAttrs(session, env.project)),
                  ),
                )
              : Effect.succeed([]),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const sessionId = yield* toPhysical(
        id,
        news.sessionId,
        output?.sessionId,
        sessionIdOf,
      );
      const name = resourceName(news.dataStore, sessionId);
      const ownership = yield* ownershipLabels(id);
      const displayName = encodeOwnershipLine(
        ownership,
        news.displayName ?? sessionId,
      );
      const labels = listFromLabels(ownership, news.labels);
      const state = news.state ?? "IN_PROGRESS";
      const desiredPinned = news.isPinned === true;

      let current = yield* findOwned(id, news.dataStore, output?.name);
      if (current === undefined) {
        current = yield* getByName(name);
      }

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsCollectionsDataStoresSessions({
            parent: news.dataStore,
            sessionId,
            body: {
              displayName,
              state,
              userPseudoId: news.userPseudoId,
              labels,
              isPinned: desiredPinned ? true : undefined,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CollectionsDataStoresSessionNotResolved({ name });
      }

      const resource = current.name ?? name;
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const stateChanged = (current.state ?? "") !== state;
      const userChanged =
        (current.userPseudoId ?? "") !== (news.userPseudoId ?? "");
      const observedLabels = [...(current.labels ?? [])].sort().join("\0");
      const desiredLabels = [...labels].sort().join("\0");
      const labelsChanged = observedLabels !== desiredLabels;
      const pinnedChanged = (current.isPinned === true) !== desiredPinned;

      if (
        displayNameChanged ||
        stateChanged ||
        userChanged ||
        labelsChanged ||
        pinnedChanged
      ) {
        current =
          yield* discoveryengine.patchProjectsLocationsCollectionsDataStoresSessions(
            {
              name: resource,
              updateMask: [
                displayNameChanged ? "display_name" : undefined,
                stateChanged ? "state" : undefined,
                userChanged ? "user_pseudo_id" : undefined,
                labelsChanged ? "labels" : undefined,
                pinnedChanged ? "is_pinned" : undefined,
              ]
                .filter((field): field is string => field !== undefined)
                .join(","),
              body: {
                name: resource,
                displayName,
                state,
                userPseudoId: news.userPseudoId,
                labels,
                isPinned: desiredPinned,
              },
            },
          );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* discoveryengine
        .deleteProjectsLocationsCollectionsDataStoresSessions({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
