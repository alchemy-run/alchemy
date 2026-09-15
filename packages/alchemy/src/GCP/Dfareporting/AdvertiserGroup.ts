import * as dfa from "@distilled.cloud/gcp/dfareporting_v5";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  eachProfile,
  findByName,
  hasOwnershipMarker,
  listAdvertiserGroups,
  ownedByAlchemy,
  ownedName,
  parseOwnership,
  profileIdFromEnv,
  replaceIfChanged,
  sameText,
} from "./internal.ts";

export type AdvertiserGroupProps = {
  /**
   * Campaign Manager 360 user profile id. Immutable — changing it
   * replaces the advertiser group.
   */
  profileId: string;
  /**
   * System-assigned advertiser group id. Omit on create; pass the
   * observed id to update in place.
   */
  id?: string;
  /**
   * Display name (max 256 characters, unique per account). Advertiser
   * groups have no labels field, so Alchemy ownership is stored in a
   * `[alchemy …]` prefix and stripped from attributes.
   */
  name?: string;
};

export type AdvertiserGroup = Resource<
  "GCP.Dfareporting.AdvertiserGroup",
  AdvertiserGroupProps,
  {
    /** System-assigned advertiser group id. */
    id: string;
    /** User profile id used to manage the group. */
    profileId: string;
    /** CM360 account id. */
    accountId: string | undefined;
    /** User display name with the Alchemy ownership prefix stripped. */
    name: string | undefined;
    /** Resource kind (`dfareporting#advertiserGroup`). */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Campaign Manager 360 advertiser group.
 *
 * Groups have no labels field — Alchemy stamps ownership into `name` so
 * `list` / nuke can find them. Profile id is immutable. Name updates in
 * place and must stay unique in the account.
 *
 * ### Creating an Advertiser Group
 * **Example:** Named group
 * ```typescript
 * const group = yield* GCP.Dfareporting.AdvertiserGroup("Brands", {
 *   profileId: "123",
 *   name: "alchemy-brands",
 * });
 * ```
 *
 * ### Updating an Advertiser Group
 * **Example:** Rename
 * ```typescript
 * const group = yield* GCP.Dfareporting.AdvertiserGroup("Brands", {
 *   profileId: existing.profileId,
 *   id: existing.id,
 *   name: "alchemy-brands-v2",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Dfareporting
 */
export const AdvertiserGroup = Resource<AdvertiserGroup>(
  "GCP.Dfareporting.AdvertiserGroup",
);

export class AdvertiserGroupNotResolved extends Data.TaggedError(
  "GCP.Dfareporting.AdvertiserGroupNotResolved",
)<{
  profileId: string;
  id: string;
}> {}

const toAttrs = (group: dfa.AdvertiserGroup, profileId: string) => ({
  id: group.id ?? "",
  profileId,
  accountId: group.accountId,
  name: parseOwnership(group.name).text,
  kind: group.kind,
});

const getById = (profileId: string, id: string | undefined) =>
  !profileId || !id
    ? Effect.succeed(undefined)
    : dfa
        .getAdvertiserGroups({ profileId, id })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findOwned = (profileId: string, name: string) =>
  listAdvertiserGroups(profileId).pipe(
    Effect.map((groups) => findByName(groups, name)),
  );

export const AdvertiserGroupProvider = () =>
  Provider.succeed(AdvertiserGroup, {
    stables: ["id", "profileId", "accountId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return (
        replaceIfChanged(
          olds?.profileId ?? output?.profileId,
          news.profileId,
        ) ?? replaceIfChanged(olds?.id ?? output?.id, news.id, true)
      );
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const profileId =
        olds?.profileId ?? output?.profileId ?? profileIdFromEnv() ?? "";
      let existing = yield* getById(profileId, olds?.id ?? output?.id);
      if (existing === undefined && profileId) {
        const name = yield* ownedName(
          id,
          olds?.name,
          parseOwnership(output?.name).text,
        );
        existing = yield* findOwned(profileId, name);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, profileId);
      return (yield* ownedByAlchemy(id, existing.name))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      eachProfile((profileId) =>
        listAdvertiserGroups(profileId).pipe(
          Effect.map((rows) =>
            rows
              .filter((row) => hasOwnershipMarker(row.name))
              .map((row) => toAttrs(row, profileId)),
          ),
        ),
      ),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const profileId = news.profileId;
      const name = yield* ownedName(
        id,
        news.name,
        parseOwnership(output?.name).text,
      );

      let current = yield* getById(profileId, news.id ?? output?.id);
      if (current === undefined) {
        current = yield* findOwned(profileId, name);
      }

      if (current === undefined) {
        const created = yield* dfa
          .insertAdvertiserGroups({
            profileId,
            body: { name },
          })
          .pipe(Effect.catchTag("Conflict", () => findOwned(profileId, name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AdvertiserGroupNotResolved({
          profileId,
          id: news.id ?? output?.id ?? name,
        });
      }

      const groupId = current.id ?? "";
      if (!sameText(current.name, name)) {
        current = yield* dfa.patchAdvertiserGroups({
          profileId,
          id: groupId,
          body: { id: groupId, name },
        });
      }

      return toAttrs(current, profileId);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.profileId || !output.id) return;
      yield* dfa
        .deleteAdvertiserGroups({
          profileId: output.profileId,
          id: output.id,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
