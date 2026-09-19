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
  findByName,
  hasOwnershipMarker,
  jsonEqual,
  listEventTags,
  ownedByAlchemy,
  ownedName,
  parseOwnership,
  profileIdFromEnv,
  replaceIfChanged,
  sameBool,
  sameNumber,
  sameText,
} from "./internal.ts";

export type EventTagType =
  | "IMPRESSION_IMAGE_EVENT_TAG"
  | "IMPRESSION_JAVASCRIPT_EVENT_TAG"
  | "CLICK_THROUGH_EVENT_TAG";

export type EventTagStatus = "ENABLED" | "DISABLED";

export type EventTagSiteFilterType = "ALLOWLIST" | "BLOCKLIST";

export type EventTagProps = {
  /**
   * Campaign Manager 360 user profile id. Immutable — changing it
   * replaces the event tag.
   */
  profileId: string;
  /**
   * Advertiser that owns the tag. Required on insert unless
   * `campaignId` is set. Immutable — changing it replaces the tag.
   */
  advertiserId?: string;
  /**
   * Campaign that owns the tag. Required on insert unless
   * `advertiserId` is set. Immutable — changing it replaces the tag.
   */
  campaignId?: string;
  /**
   * System-assigned event tag id. Omit on create; pass the observed id
   * to update in place.
   */
  id?: string;
  /**
   * Display name (max 256 characters). Event tags have no labels field,
   * so Alchemy ownership is stored in a `[alchemy …]` prefix and
   * stripped from attributes.
   */
  name?: string;
  /**
   * Event tag type (`IMPRESSION_IMAGE_EVENT_TAG`,
   * `IMPRESSION_JAVASCRIPT_EVENT_TAG`, or `CLICK_THROUGH_EVENT_TAG`).
   * Immutable — changing it replaces the tag.
   * @default "IMPRESSION_IMAGE_EVENT_TAG"
   */
  type?: EventTagType | string;
  /**
   * Payload URL. Required on insert.
   */
  url: string;
  /**
   * Serving status. Must be `ENABLED` for the tag to fire.
   * @default "ENABLED"
   */
  status?: EventTagStatus | string;
  /**
   * Enable this tag for all of the advertiser's campaigns and ads.
   * @default false
   */
  enabledByDefault?: boolean;
  /**
   * Remove this tag from ads trafficked through Display and Video 360
   * to Ad Exchange.
   * @default false
   */
  excludeFromAdxRequests?: boolean;
  /**
   * Site ids this tag is filtered to.
   */
  siteIds?: string[];
  /**
   * Whether `siteIds` is an allowlist or blocklist.
   */
  siteFilterType?: EventTagSiteFilterType | string;
  /**
   * Times to URL-escape the landing page URL on click-through tags.
   */
  urlEscapeLevels?: number;
};

export type EventTag = Resource<
  "GCP.Dfareporting.EventTag",
  EventTagProps,
  {
    /** System-assigned event tag id. */
    id: string;
    /** User profile id used to manage the tag. */
    profileId: string;
    /** Parent advertiser id. */
    advertiserId: string | undefined;
    /** Parent campaign id. */
    campaignId: string | undefined;
    /** CM360 account id. */
    accountId: string | undefined;
    /** CM360 subaccount id. */
    subaccountId: string | undefined;
    /** User display name with the Alchemy ownership prefix stripped. */
    name: string | undefined;
    /** Event tag type. */
    type: string | undefined;
    /** Payload URL. */
    url: string | undefined;
    /** Serving status. */
    status: string | undefined;
    /** Whether the tag is enabled by default on campaigns and ads. */
    enabledByDefault: boolean;
    /** Whether the tag is excluded from Ad Exchange requests. */
    excludeFromAdxRequests: boolean;
    /** Filtered site ids. */
    siteIds: string[] | undefined;
    /** Site filter type. */
    siteFilterType: string | undefined;
    /** Landing-page URL escape levels. */
    urlEscapeLevels: number | undefined;
    /** Whether the tag is SSL-compliant. */
    sslCompliant: boolean | undefined;
    /** Resource kind (`dfareporting#eventTag`). */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Campaign Manager 360 event tag.
 *
 * Event tags have no labels field — Alchemy stamps ownership into `name`
 * so `list` / nuke can find them. Profile, advertiser/campaign, and type
 * are immutable. Name, URL, and status update in place.
 *
 * ### Creating an Event Tag
 * **Example:** Impression pixel
 * ```typescript
 * const tag = yield* GCP.Dfareporting.EventTag("Pixel", {
 *   profileId: "123",
 *   advertiserId: "456",
 *   name: "alchemy-pixel",
 *   type: "IMPRESSION_IMAGE_EVENT_TAG",
 *   url: "https://example.com/pixel",
 * });
 * ```
 *
 * ### Updating an Event Tag
 * **Example:** Disable the tag
 * ```typescript
 * const tag = yield* GCP.Dfareporting.EventTag("Pixel", {
 *   profileId: existing.profileId,
 *   advertiserId: existing.advertiserId,
 *   id: existing.id,
 *   name: "alchemy-pixel",
 *   type: "IMPRESSION_IMAGE_EVENT_TAG",
 *   url: "https://example.com/pixel",
 *   status: "DISABLED",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Dfareporting
 */
export const EventTag = Resource<EventTag>("GCP.Dfareporting.EventTag");

export class EventTagNotResolved extends Data.TaggedError(
  "GCP.Dfareporting.EventTagNotResolved",
)<{
  profileId: string;
  id: string;
}> {}

const DEFAULT_TYPE: EventTagType = "IMPRESSION_IMAGE_EVENT_TAG";
const DEFAULT_STATUS: EventTagStatus = "ENABLED";

const toAttrs = (tag: dfa.EventTag, profileId: string) => ({
  id: tag.id ?? "",
  profileId,
  advertiserId: tag.advertiserId,
  campaignId: tag.campaignId,
  accountId: tag.accountId,
  subaccountId: tag.subaccountId,
  name: parseOwnership(tag.name).text,
  type: tag.type,
  url: tag.url,
  status: tag.status,
  enabledByDefault: tag.enabledByDefault === true,
  excludeFromAdxRequests: tag.excludeFromAdxRequests === true,
  siteIds: tag.siteIds,
  siteFilterType: tag.siteFilterType,
  urlEscapeLevels: tag.urlEscapeLevels,
  sslCompliant: tag.sslCompliant,
  kind: tag.kind,
});

const getById = (profileId: string, id: string | undefined) =>
  !profileId || !id
    ? Effect.succeed(undefined)
    : dfa
        .getEventTags({ profileId, id })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findOwned = (
  profileId: string,
  advertiserId: string | undefined,
  name: string,
) =>
  listEventTags(profileId, advertiserId).pipe(
    Effect.map((tags) => findByName(tags, name)),
  );

export const EventTagProvider = () =>
  Provider.succeed(EventTag, {
    stables: ["id", "profileId", "advertiserId", "campaignId", "accountId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const type = news.type ?? DEFAULT_TYPE;
      return (
        replaceIfChanged(
          olds?.profileId ?? output?.profileId,
          news.profileId,
        ) ??
        replaceIfChanged(
          olds?.advertiserId ?? output?.advertiserId,
          news.advertiserId,
        ) ??
        replaceIfChanged(
          olds?.campaignId ?? output?.campaignId,
          news.campaignId,
        ) ??
        replaceIfChanged(olds?.type ?? output?.type, type) ??
        replaceIfChanged(olds?.id ?? output?.id, news.id, true)
      );
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const profileId =
        olds?.profileId ?? output?.profileId ?? profileIdFromEnv() ?? "";
      const advertiserId =
        olds?.advertiserId ?? output?.advertiserId ?? advertiserIdFromEnv();
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
        listEventTags(profileId).pipe(
          Effect.map((rows) =>
            rows
              .filter((row) => hasOwnershipMarker(row.name))
              .map((row) => toAttrs(row, profileId)),
          ),
        ),
      ),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const profileId = news.profileId;
      const type = news.type ?? DEFAULT_TYPE;
      const status = news.status ?? DEFAULT_STATUS;
      const enabledByDefault = news.enabledByDefault === true;
      const excludeFromAdxRequests = news.excludeFromAdxRequests === true;
      const name = yield* ownedName(
        id,
        news.name,
        parseOwnership(output?.name).text,
      );
      const body: dfa.EventTag = {
        advertiserId: news.advertiserId,
        campaignId: news.campaignId,
        name,
        type,
        url: news.url,
        status,
        enabledByDefault,
        excludeFromAdxRequests,
        siteIds: news.siteIds,
        siteFilterType: news.siteFilterType,
        urlEscapeLevels: news.urlEscapeLevels,
      };

      let current = yield* getById(profileId, news.id ?? output?.id);
      if (current === undefined) {
        current = yield* findOwned(profileId, news.advertiserId, name);
      }

      if (current === undefined) {
        const created = yield* dfa
          .insertEventTags({
            profileId,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwned(profileId, news.advertiserId, name),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new EventTagNotResolved({
          profileId,
          id: news.id ?? output?.id ?? name,
        });
      }

      const tagId = current.id ?? "";
      const changed =
        !sameText(current.name, name) ||
        !sameText(current.url, news.url) ||
        !sameText(current.status, status) ||
        !sameBool(current.enabledByDefault, enabledByDefault) ||
        !sameBool(current.excludeFromAdxRequests, excludeFromAdxRequests) ||
        !jsonEqual(current.siteIds, news.siteIds) ||
        !sameText(current.siteFilterType, news.siteFilterType) ||
        !sameNumber(current.urlEscapeLevels, news.urlEscapeLevels);
      if (changed) {
        current = yield* dfa.patchEventTags({
          profileId,
          id: tagId,
          body: { ...body, id: tagId },
        });
      }

      return toAttrs(current, profileId);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.profileId || !output.id) return;
      yield* dfa
        .deleteEventTags({
          profileId: output.profileId,
          id: output.id,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
