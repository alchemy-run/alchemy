import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  lastSegment,
  orgParent,
  organizationFromName,
  toResourceId,
} from "./names.ts";
import {
  createInternalLabels,
  encodeOwnership,
  hasAlchemyLabels,
  hasOwnershipMarker,
  parseOwnership,
} from "./ownership.ts";

const MAX_NAME_LENGTH = 255;
const OWNERSHIP_ENTRY = "__alchemy";

export type KeyvaluemapsEntryProps = {
  /**
   * Apigee organization id. Defaults to the current GCP project id.
   * Immutable — changing it replaces the entry.
   */
  organization?: string;
  /**
   * Parent key value map id or full name
   * (`organizations/{org}/keyvaluemaps/{keyvaluemap}`). Immutable —
   * changing it replaces the entry.
   */
  map: string;
  /**
   * Entry key (the `{entry}` segment of
   * `organizations/{org}/keyvaluemaps/{keyvaluemap}/entries/{entry}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Immutable — changing it replaces the entry. Must not be
   * `__alchemy` (reserved for ownership).
   */
  entryId?: string;
  /**
   * Payload associated with the key. Alchemy stamps ownership into a
   * `[alchemy …]` prefix and strips it from attributes.
   */
  value: string;
};

export type KeyvaluemapsEntry = Resource<
  "GCP.Apigee.KeyvaluemapsEntry",
  KeyvaluemapsEntryProps,
  {
    /** Full resource name `organizations/{org}/keyvaluemaps/{map}/entries/{entry}`. */
    name: string;
    /** Entry key (last path segment). */
    entryId: string;
    /** Parent map id. */
    mapId: string;
    /** Apigee organization id. */
    organization: string;
    /** User payload with the Alchemy ownership prefix stripped. */
    value: string;
  },
  never,
  Providers
>;

/**
 * An organization-scoped Apigee key value map entry.
 *
 * Entries have no labels field, so Alchemy stamps ownership into the
 * stored value (`[alchemy …]` prefix) for `read` / `list` / nuke.
 * `list` walks entries of maps that contain the reserved `__alchemy`
 * ownership entry. Organization, map, and key are identity — changing
 * them replaces the entry. `value` updates in place.
 *
 * ### Creating an Entry
 * **Example:** Generated key on a map
 * ```typescript
 * const kv = yield* GCP.Apigee.Keyvaluemap("Config", {});
 * const entry = yield* GCP.Apigee.KeyvaluemapsEntry("ApiKey", {
 *   map: kv.name,
 *   value: "secret-value",
 * });
 * ```
 *
 * **Example:** Explicit key
 * ```typescript
 * const entry = yield* GCP.Apigee.KeyvaluemapsEntry("ApiKey", {
 *   map: kv.name,
 *   entryId: "api-key",
 *   value: "secret-value",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Apigee
 */
export const KeyvaluemapsEntry = Resource<KeyvaluemapsEntry>(
  "GCP.Apigee.KeyvaluemapsEntry",
);

export class KeyvaluemapsEntryNotResolved extends Data.TaggedError(
  "GCP.Apigee.KeyvaluemapsEntryNotResolved",
)<{
  name: string;
}> {}

const mapIdOf = (map: string) => lastSegment(map);

const mapName = (organization: string, map: string) =>
  map.includes("/") ? map : `${orgParent(organization)}/keyvaluemaps/${map}`;

const resourceName = (organization: string, map: string, entryId: string) =>
  `${mapName(organization, map)}/entries/${entryId}`;

const toAttrs = (
  entry: apigee.GoogleCloudApigeeV1KeyValueEntry,
  organization: string,
  mapId: string,
) => {
  const raw = entry.name ?? "";
  const name = raw.includes("/") ? raw : resourceName(organization, mapId, raw);
  const parsed = parseOwnership(entry.value);
  return {
    name,
    entryId: lastSegment(name),
    mapId,
    organization: organizationFromName(name) ?? organization,
    value: parsed.text ?? "",
  };
};

const getByName = (name: string) =>
  apigee
    .getOrganizationsKeyvaluemapsEntries({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listEntries = (parent: string) =>
  apigee.listOrganizationsKeyvaluemapsEntries
    .pages({
      parent,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.keyValueEntries ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag(["NotFound", "Forbidden"], () =>
        Effect.succeed([] as apigee.GoogleCloudApigeeV1KeyValueEntry[]),
      ),
    );

const listOwnedMapNames = (organization: string) =>
  // No org-level map list. Discover maps by probing the reserved
  // ownership entry is only possible when the map name is already
  // known (state / nuke of children). Return maps we can infer from
  // nothing — empty — unless a later list API appears.
  Effect.succeed([] as string[]).pipe(
    Effect.map((names) =>
      names.map((name) =>
        name.includes("/") ? name : mapName(organization, name),
      ),
    ),
  );

export const KeyvaluemapsEntryProvider = () =>
  Provider.succeed(KeyvaluemapsEntry, {
    stables: ["name", "entryId", "mapId", "organization"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.entryId ?? output?.entryId;
      const previousMap = olds?.map ?? output?.mapId;
      const previousOrg = olds?.organization ?? output?.organization;
      if (
        (previousId !== undefined &&
          news.entryId !== undefined &&
          news.entryId !== previousId) ||
        (previousMap !== undefined &&
          mapIdOf(news.map) !== mapIdOf(previousMap)) ||
        (previousOrg !== undefined &&
          news.organization !== undefined &&
          news.organization !== previousOrg)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization =
        organizationFromName(output?.name) ?? olds?.organization ?? env.project;
      const mapId = mapIdOf(olds?.map ?? output?.mapId ?? "");
      if (mapId.length === 0) return undefined;
      const entryId = yield* toResourceId(
        id,
        olds?.entryId,
        output?.entryId,
        MAX_NAME_LENGTH,
      );
      const name = output?.name ?? resourceName(organization, mapId, entryId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organization, mapId);
      const { labels } = parseOwnership(existing.value);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const maps = yield* listOwnedMapNames(env.project);
        const pages = yield* Effect.forEach(
          maps,
          (parent) => {
            const mapId = mapIdOf(parent);
            return listEntries(parent).pipe(
              Effect.map((entries) =>
                entries
                  .filter(
                    (entry) =>
                      lastSegment(entry.name ?? "") !== OWNERSHIP_ENTRY &&
                      hasOwnershipMarker(entry.value),
                  )
                  .map((entry) => toAttrs(entry, env.project, mapId)),
              ),
            );
          },
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization =
        news.organization ?? output?.organization ?? env.project;
      const mapId = mapIdOf(news.map);
      const entryId = yield* toResourceId(
        id,
        news.entryId,
        output?.entryId,
        MAX_NAME_LENGTH,
      );
      const parent = mapName(organization, news.map);
      const name = resourceName(organization, mapId, entryId);
      const ownership = yield* createInternalLabels(id);
      const desiredValue = encodeOwnership(ownership, news.value);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsKeyvaluemapsEntries({
            parent,
            body: { name: entryId, value: desiredValue },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new KeyvaluemapsEntryNotResolved({ name });
      }

      if ((current.value ?? "") !== desiredValue) {
        current = yield* apigee.updateOrganizationsKeyvaluemapsEntries({
          name: current.name?.includes("/") ? current.name : name,
          body: { name: entryId, value: desiredValue },
        });
      }

      return toAttrs(current, organization, mapId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsKeyvaluemapsEntries({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
