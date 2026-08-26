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
  findByValue,
  hasOwnershipMarker,
  listCreativeFields,
  listCreativeFieldValues,
  ownedByAlchemy,
  ownedName,
  parseOwnership,
  profileIdFromEnv,
  replaceIfChanged,
  sameText,
} from "./internal.ts";

export type CreativeFieldValueProps = {
  /**
   * Campaign Manager 360 user profile id. Immutable — changing it
   * replaces the value.
   */
  profileId: string;
  /**
   * Parent creative field id. Immutable — changing it replaces the
   * value.
   */
  creativeFieldId: string;
  /**
   * System-assigned creative field value id. Omit on create; pass the
   * observed id to update in place.
   */
  id?: string;
  /**
   * Field value (max 256 characters, unique per creative field). Values
   * have no labels field, so Alchemy ownership is stored in a
   * `[alchemy …]` prefix and stripped from attributes.
   */
  value?: string;
};

export type CreativeFieldValue = Resource<
  "GCP.Dfareporting.CreativeFieldValue",
  CreativeFieldValueProps,
  {
    /** System-assigned creative field value id. */
    id: string;
    /** User profile id used to manage the value. */
    profileId: string;
    /** Parent creative field id. */
    creativeFieldId: string;
    /** User value with the Alchemy ownership prefix stripped. */
    value: string | undefined;
    /** Resource kind (`dfareporting#creativeFieldValue`). */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Campaign Manager 360 creative field value.
 *
 * Values have no labels field — Alchemy stamps ownership into `value` so
 * `list` / nuke can find them. Profile and creative field ids are
 * immutable. The value string updates in place.
 *
 * ### Creating a Creative Field Value
 * **Example:** Named value
 * ```typescript
 * const value = yield* GCP.Dfareporting.CreativeFieldValue("Red", {
 *   profileId: field.profileId,
 *   creativeFieldId: field.id,
 *   value: "red",
 * });
 * ```
 *
 * ### Updating a Creative Field Value
 * **Example:** Rename
 * ```typescript
 * const value = yield* GCP.Dfareporting.CreativeFieldValue("Red", {
 *   profileId: existing.profileId,
 *   creativeFieldId: existing.creativeFieldId,
 *   id: existing.id,
 *   value: "crimson",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Dfareporting
 */
export const CreativeFieldValue = Resource<CreativeFieldValue>(
  "GCP.Dfareporting.CreativeFieldValue",
);

export class CreativeFieldValueNotResolved extends Data.TaggedError(
  "GCP.Dfareporting.CreativeFieldValueNotResolved",
)<{
  profileId: string;
  creativeFieldId: string;
  id: string;
}> {}

const toAttrs = (
  value: dfa.CreativeFieldValue,
  profileId: string,
  creativeFieldId: string,
) => ({
  id: value.id ?? "",
  profileId,
  creativeFieldId,
  value: parseOwnership(value.value).text,
  kind: value.kind,
});

const getById = (
  profileId: string,
  creativeFieldId: string,
  id: string | undefined,
) =>
  !profileId || !creativeFieldId || !id
    ? Effect.succeed(undefined)
    : dfa
        .getCreativeFieldValues({ profileId, creativeFieldId, id })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findOwned = (profileId: string, creativeFieldId: string, value: string) =>
  listCreativeFieldValues(profileId, creativeFieldId).pipe(
    Effect.map((values) => findByValue(values, value)),
  );

const listFieldIds = (profileId: string) =>
  listCreativeFields(profileId).pipe(
    Effect.map((rows) =>
      rows.map((row) => row.id).filter((id): id is string => !!id),
    ),
  );

export const CreativeFieldValueProvider = () =>
  Provider.succeed(CreativeFieldValue, {
    stables: ["id", "profileId", "creativeFieldId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return (
        replaceIfChanged(
          olds?.profileId ?? output?.profileId,
          news.profileId,
        ) ??
        replaceIfChanged(
          olds?.creativeFieldId ?? output?.creativeFieldId,
          news.creativeFieldId,
        ) ??
        replaceIfChanged(olds?.id ?? output?.id, news.id, true)
      );
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const profileId =
        olds?.profileId ?? output?.profileId ?? profileIdFromEnv() ?? "";
      const creativeFieldId =
        olds?.creativeFieldId ?? output?.creativeFieldId ?? "";
      let existing = yield* getById(
        profileId,
        creativeFieldId,
        olds?.id ?? output?.id,
      );
      if (existing === undefined && profileId && creativeFieldId) {
        const value = yield* ownedName(
          id,
          olds?.value,
          parseOwnership(output?.value).text,
        );
        existing = yield* findOwned(profileId, creativeFieldId, value);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, profileId, creativeFieldId);
      return (yield* ownedByAlchemy(id, existing.value))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      eachProfile((profileId) =>
        Effect.gen(function* () {
          const fieldIds = yield* listFieldIds(profileId);
          const pages = yield* Effect.forEach(
            fieldIds,
            (creativeFieldId) =>
              listCreativeFieldValues(profileId, creativeFieldId).pipe(
                Effect.map((rows) =>
                  rows
                    .filter((row) => hasOwnershipMarker(row.value))
                    .map((row) => toAttrs(row, profileId, creativeFieldId)),
                ),
              ),
            { concurrency: 4 },
          );
          return pages.flat();
        }),
      ),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const profileId = news.profileId;
      const creativeFieldId = news.creativeFieldId;
      const value = yield* ownedName(
        id,
        news.value,
        parseOwnership(output?.value).text,
      );

      let current = yield* getById(
        profileId,
        creativeFieldId,
        news.id ?? output?.id,
      );
      if (current === undefined) {
        current = yield* findOwned(profileId, creativeFieldId, value);
      }

      if (current === undefined) {
        const created = yield* dfa
          .insertCreativeFieldValues({
            profileId,
            creativeFieldId,
            body: { value },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwned(profileId, creativeFieldId, value),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CreativeFieldValueNotResolved({
          profileId,
          creativeFieldId,
          id: news.id ?? output?.id ?? value,
        });
      }

      const valueId = current.id ?? "";
      if (!sameText(current.value, value)) {
        current = yield* dfa.patchCreativeFieldValues({
          profileId,
          creativeFieldId,
          id: valueId,
          body: { id: valueId, value },
        });
      }

      return toAttrs(current, profileId, creativeFieldId);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.profileId || !output.creativeFieldId || !output.id) return;
      yield* dfa
        .deleteCreativeFieldValues({
          profileId: output.profileId,
          creativeFieldId: output.creativeFieldId,
          id: output.id,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
