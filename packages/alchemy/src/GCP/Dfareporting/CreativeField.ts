import * as dfa from "@distilled.cloud/gcp/dfareporting_v5";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  advertiserIdFromEnv,
  eachProfile,
  hasOwnershipMarker,
  listCreativeFields,
  ownedByAlchemy,
  ownedName,
  parseOwnership,
  profileIdFromEnv,
  replaceIfChanged,
  sameText,
} from "./internal.ts";

export type CreativeFieldProps = {
  /**
   * Campaign Manager 360 user profile id. Immutable — changing it
   * replaces the creative field.
   */
  profileId: string;
  /**
   * Advertiser that owns the field. Required on insert. Immutable —
   * changing it replaces the field.
   */
  advertiserId: string;
  /**
   * System-assigned creative field id. Omit on create; pass the
   * observed id to update in place.
   */
  id?: string;
  /**
   * Display name (max 256 characters, unique per advertiser). Creative
   * fields have no labels field, so Alchemy ownership is stored in a
   * `[alchemy …]` prefix and stripped from attributes.
   */
  name?: string;
};

export type CreativeField = Resource<
  "GCP.Dfareporting.CreativeField",
  CreativeFieldProps,
  {
    /** System-assigned creative field id. */
    id: string;
    /** User profile id used to manage the field. */
    profileId: string;
    /** Parent advertiser id. */
    advertiserId: string;
    /** CM360 account id. */
    accountId: string | undefined;
    /** CM360 subaccount id. */
    subaccountId: string | undefined;
    /** User display name with the Alchemy ownership prefix stripped. */
    name: string | undefined;
    /** Resource kind (`dfareporting#creativeField`). */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Campaign Manager 360 creative field under an advertiser.
 *
 * Fields have no labels field — Alchemy stamps ownership into `name` so
 * `list` / nuke can find them. Profile and advertiser ids are immutable.
 * Name updates in place.
 *
 * ### Creating a Creative Field
 * **Example:** Named field
 * ```typescript
 * const field = yield* GCP.Dfareporting.CreativeField("Color", {
 *   profileId: "123",
 *   advertiserId: "456",
 *   name: "alchemy-color",
 * });
 * ```
 *
 * ### Updating a Creative Field
 * **Example:** Rename
 * ```typescript
 * const field = yield* GCP.Dfareporting.CreativeField("Color", {
 *   profileId: existing.profileId,
 *   advertiserId: existing.advertiserId,
 *   id: existing.id,
 *   name: "alchemy-color-v2",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Dfareporting
 */
export const CreativeField = Resource<CreativeField>(
  "GCP.Dfareporting.CreativeField",
);

export class CreativeFieldNotResolved extends Data.TaggedError(
  "GCP.Dfareporting.CreativeFieldNotResolved",
)<{
  profileId: string;
  id: string;
}> {}

const toAttrs = (field: dfa.CreativeField, profileId: string) => ({
  id: field.id ?? "",
  profileId,
  advertiserId: field.advertiserId ?? "",
  accountId: field.accountId,
  subaccountId: field.subaccountId,
  name: parseOwnership(field.name).text,
  kind: field.kind,
});

const getById = (profileId: string, id: string | undefined) =>
  !profileId || !id
    ? Effect.succeed(undefined)
    : dfa
        .getCreativeFields({ profileId, id })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findOwned = (profileId: string, advertiserId: string, name: string) =>
  listCreativeFields(profileId, advertiserId ? [advertiserId] : undefined).pipe(
    Effect.map((fields) =>
      fields.find(
        (field) =>
          field.name === name &&
          (advertiserId.length === 0 || field.advertiserId === advertiserId),
      ),
    ),
  );

export const CreativeFieldProvider = () =>
  Provider.succeed(CreativeField, {
    stables: ["id", "profileId", "advertiserId", "accountId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return (
        replaceIfChanged(
          olds?.profileId ?? output?.profileId,
          news.profileId,
        ) ??
        replaceIfChanged(
          olds?.advertiserId ?? output?.advertiserId,
          news.advertiserId,
        ) ??
        replaceIfChanged(olds?.id ?? output?.id, news.id, true)
      );
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const profileId =
        olds?.profileId ?? output?.profileId ?? profileIdFromEnv() ?? "";
      const advertiserId =
        olds?.advertiserId ??
        output?.advertiserId ??
        advertiserIdFromEnv() ??
        "";
      let existing = yield* getById(profileId, olds?.id ?? output?.id);
      if (existing === undefined && profileId) {
        const name = yield* ownedName(
          id,
          olds?.name,
          parseOwnership(output?.name).text,
        );
        existing = yield* findOwned(profileId, advertiserId, name);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, profileId);
      return (yield* ownedByAlchemy(id, existing.name))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      eachProfile((profileId) =>
        listCreativeFields(profileId).pipe(
          Effect.map((rows) =>
            rows
              .filter((row) => hasOwnershipMarker(row.name))
              .map((row) => toAttrs(row, profileId)),
          ),
        ),
      ),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const profileId = news.profileId;
      const advertiserId = news.advertiserId;
      const name = yield* ownedName(
        id,
        news.name,
        parseOwnership(output?.name).text,
      );

      let current = yield* getById(profileId, news.id ?? output?.id);
      if (current === undefined) {
        current = yield* findOwned(profileId, advertiserId, name);
      }

      if (current === undefined) {
        const created = yield* dfa
          .insertCreativeFields({
            profileId,
            body: { advertiserId, name },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwned(profileId, advertiserId, name),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CreativeFieldNotResolved({
          profileId,
          id: news.id ?? output?.id ?? name,
        });
      }

      const fieldId = current.id ?? "";
      if (!sameText(current.name, name)) {
        current = yield* dfa.patchCreativeFields({
          profileId,
          id: fieldId,
          body: { id: fieldId, advertiserId, name },
        });
      }

      return toAttrs(current, profileId);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.profileId || !output.id) return;
      yield* dfa
        .deleteCreativeFields({
          profileId: output.profileId,
          id: output.id,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
