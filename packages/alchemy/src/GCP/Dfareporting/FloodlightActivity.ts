import * as dfa from "@distilled.cloud/gcp/dfareporting_v5";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  advertiserIdFromEnv,
  eachProfile,
  encodeOwnership,
  findByName,
  floodlightActivityGroupIdFromEnv,
  hasOwnershipMarker,
  jsonEqual,
  listAdvertiserIds,
  listFloodlightActivities,
  MAX_FLOODLIGHT_NAME_LENGTH,
  ownedByAlchemy,
  ownedName,
  parseOwnership,
  profileIdFromEnv,
  replaceIfChanged,
  sameBool,
  sameText,
  sanitizeFloodlightName,
} from "./internal.ts";

export type FloodlightDynamicTag = {
  /** System-assigned dynamic tag id. */
  id?: string;
  /** Dynamic tag name. */
  name?: string;
  /** Tag code. */
  tag?: string;
};

export type FloodlightPublisherDynamicTag = {
  /** Site id this tag applies to. */
  siteId?: string;
  /** Directory site id (write-only alternative to `siteId`). */
  directorySiteId?: string;
  /** Whether this tag fires on click-throughs. */
  clickThrough?: boolean;
  /** Whether this tag fires on view-throughs. */
  viewThrough?: boolean;
  /** Nested floodlight tag. */
  dynamicTag?: FloodlightDynamicTag;
};

export type FloodlightActivityProps = {
  /**
   * Campaign Manager 360 user profile id. Immutable — changing it
   * replaces the activity.
   */
  profileId: string;
  /**
   * Floodlight activity group id. Required on insert. Immutable —
   * changing it replaces the activity.
   */
  floodlightActivityGroupId: string;
  /**
   * Advertiser id. Copied from the activity group when omitted.
   */
  advertiserId?: string;
  /**
   * Floodlight configuration id. Copied from the activity group when
   * omitted.
   */
  floodlightConfigurationId?: string;
  /**
   * System-assigned activity id. Omit on create; pass the observed id
   * to update in place.
   */
  id?: string;
  /**
   * Display name (max 128 characters, no quotes). Alchemy ownership is
   * stamped into both `name` and `notes`.
   */
  name?: string;
  /**
   * Implementation notes. Alchemy ownership is prefixed automatically.
   */
  notes?: string;
  /**
   * Counting method. Required on insert.
   * @default "STANDARD_COUNTING"
   */
  countingMethod?: string;
  /**
   * Generated Floodlight tag type. Required on insert.
   * @default "GLOBAL_SITE_TAG"
   */
  floodlightTagType?: string;
  /**
   * Conversion category. Required on insert.
   * @default "CONVERSION_CATEGORY_PAGE_VIEW"
   */
  conversionCategory?: string;
  /**
   * Activity status (`ACTIVE` or `ARCHIVED_AND_DISABLED`).
   * @default "ACTIVE"
   */
  status?: string;
  /**
   * Expected deployment URL (max 256 characters).
   */
  expectedUrl?: string;
  /**
   * Tag string (`cat=` parameter). Immutable after insert.
   */
  tagString?: string;
  /**
   * Tag format (`HTML` or `XHTML`).
   */
  tagFormat?: string;
  /**
   * Cache-busting code type.
   */
  cacheBustingType?: string;
  /**
   * Whether the tag should use SSL.
   */
  secure?: boolean;
  /**
   * Whether the activity must be SSL-compliant.
   */
  sslRequired?: boolean;
  /**
   * Whether the activity is enabled for attribution.
   */
  attributionEnabled?: boolean;
  /**
   * User-defined variable types (`U1`–`U100`).
   */
  userDefinedVariableTypes?: string[];
  /**
   * Default dynamic floodlight tags.
   */
  defaultTags?: FloodlightDynamicTag[];
  /**
   * Publisher dynamic floodlight tags.
   */
  publisherTags?: FloodlightPublisherDynamicTag[];
};

export type FloodlightActivity = Resource<
  "GCP.Dfareporting.FloodlightActivity",
  FloodlightActivityProps,
  {
    /** System-assigned activity id. */
    id: string;
    /** User profile id used to manage the activity. */
    profileId: string;
    /** Parent activity group id. */
    floodlightActivityGroupId: string | undefined;
    /** Parent advertiser id. */
    advertiserId: string | undefined;
    /** Floodlight configuration id. */
    floodlightConfigurationId: string | undefined;
    /** CM360 account id. */
    accountId: string | undefined;
    /** CM360 subaccount id. */
    subaccountId: string | undefined;
    /** User display name with the Alchemy ownership prefix stripped. */
    name: string | undefined;
    /** User notes with the Alchemy ownership prefix stripped. */
    notes: string | undefined;
    /** Counting method. */
    countingMethod: string | undefined;
    /** Generated Floodlight tag type. */
    floodlightTagType: string | undefined;
    /** Conversion category. */
    conversionCategory: string | undefined;
    /** Activity status. */
    status: string | undefined;
    /** Expected deployment URL. */
    expectedUrl: string | undefined;
    /** Tag string. */
    tagString: string | undefined;
    /** Tag format. */
    tagFormat: string | undefined;
    /** Cache-busting type. */
    cacheBustingType: string | undefined;
    /** Whether the tag uses SSL. */
    secure: boolean | undefined;
    /** Whether SSL is required. */
    sslRequired: boolean | undefined;
    /** Whether attribution is enabled. */
    attributionEnabled: boolean | undefined;
    /** Whether the activity is SSL-compliant. */
    sslCompliant: boolean | undefined;
    /** User-defined variable types. */
    userDefinedVariableTypes: string[] | undefined;
    /** Default dynamic tags. */
    defaultTags: FloodlightDynamicTag[] | undefined;
    /** Publisher dynamic tags. */
    publisherTags: FloodlightPublisherDynamicTag[] | undefined;
    /** Activity group name. */
    floodlightActivityGroupName: string | undefined;
    /** Activity group type. */
    floodlightActivityGroupType: string | undefined;
    /** Activity group tag string. */
    floodlightActivityGroupTagString: string | undefined;
    /** Resource kind (`dfareporting#floodlightActivity`). */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Campaign Manager 360 Floodlight activity.
 *
 * Activities have no labels field — Alchemy stamps ownership into `name`
 * and `notes` so `list` / nuke can find them. Profile and activity group
 * ids are immutable. Name, notes, status, and tag settings update in
 * place.
 *
 * ### Creating a Floodlight Activity
 * **Example:** Page-view counter
 * ```typescript
 * const activity = yield* GCP.Dfareporting.FloodlightActivity("Signup", {
 *   profileId: "123",
 *   floodlightActivityGroupId: "789",
 *   name: "alchemy-signup",
 *   countingMethod: "STANDARD_COUNTING",
 *   floodlightTagType: "GLOBAL_SITE_TAG",
 *   conversionCategory: "CONVERSION_CATEGORY_SIGNUP",
 * });
 * ```
 *
 * ### Updating a Floodlight Activity
 * **Example:** Archive
 * ```typescript
 * const activity = yield* GCP.Dfareporting.FloodlightActivity("Signup", {
 *   profileId: existing.profileId,
 *   floodlightActivityGroupId: existing.floodlightActivityGroupId ?? "789",
 *   id: existing.id,
 *   name: "alchemy-signup",
 *   status: "ARCHIVED_AND_DISABLED",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Dfareporting
 */
export const FloodlightActivity = Resource<FloodlightActivity>(
  "GCP.Dfareporting.FloodlightActivity",
);

export class FloodlightActivityNotResolved extends Data.TaggedError(
  "GCP.Dfareporting.FloodlightActivityNotResolved",
)<{
  profileId: string;
  id: string;
}> {}

const DEFAULT_COUNTING = "STANDARD_COUNTING";
const DEFAULT_TAG_TYPE = "GLOBAL_SITE_TAG";
const DEFAULT_CATEGORY = "CONVERSION_CATEGORY_PAGE_VIEW";
const DEFAULT_STATUS = "ACTIVE";

const ownershipText = (activity: dfa.FloodlightActivity) =>
  activity.name ?? activity.notes;

const toAttrs = (activity: dfa.FloodlightActivity, profileId: string) => ({
  id: activity.id ?? "",
  profileId,
  floodlightActivityGroupId: activity.floodlightActivityGroupId,
  advertiserId: activity.advertiserId,
  floodlightConfigurationId: activity.floodlightConfigurationId,
  accountId: activity.accountId,
  subaccountId: activity.subaccountId,
  name: parseOwnership(activity.name).text,
  notes: parseOwnership(activity.notes).text,
  countingMethod: activity.countingMethod,
  floodlightTagType: activity.floodlightTagType,
  conversionCategory: activity.conversionCategory,
  status: activity.status,
  expectedUrl: activity.expectedUrl,
  tagString: activity.tagString,
  tagFormat: activity.tagFormat,
  cacheBustingType: activity.cacheBustingType,
  secure: activity.secure,
  sslRequired: activity.sslRequired,
  attributionEnabled: activity.attributionEnabled,
  sslCompliant: activity.sslCompliant,
  userDefinedVariableTypes: activity.userDefinedVariableTypes,
  defaultTags: activity.defaultTags,
  publisherTags: activity.publisherTags,
  floodlightActivityGroupName: activity.floodlightActivityGroupName,
  floodlightActivityGroupType: activity.floodlightActivityGroupType,
  floodlightActivityGroupTagString: activity.floodlightActivityGroupTagString,
  kind: activity.kind,
});

const getById = (profileId: string, id: string | undefined) =>
  !profileId || !id
    ? Effect.succeed(undefined)
    : dfa
        .getFloodlightActivities({ profileId, id })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findOwned = (
  profileId: string,
  advertiserId: string | undefined,
  name: string,
) =>
  advertiserId
    ? listFloodlightActivities(profileId, advertiserId).pipe(
        Effect.map((rows) => findByName(rows, name)),
      )
    : Effect.succeed(undefined);

export const FloodlightActivityProvider = () =>
  Provider.succeed(FloodlightActivity, {
    stables: [
      "id",
      "profileId",
      "floodlightActivityGroupId",
      "advertiserId",
      "accountId",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return (
        replaceIfChanged(
          olds?.profileId ?? output?.profileId,
          news.profileId,
        ) ??
        replaceIfChanged(
          olds?.floodlightActivityGroupId ?? output?.floodlightActivityGroupId,
          news.floodlightActivityGroupId,
        ) ??
        replaceIfChanged(olds?.id ?? output?.id, news.id, true)
      );
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const profileId =
        olds?.profileId ?? output?.profileId ?? profileIdFromEnv() ?? "";
      const advertiserId =
        olds?.advertiserId ?? output?.advertiserId ?? advertiserIdFromEnv();
      let existing = yield* getById(profileId, olds?.id ?? output?.id);
      if (existing === undefined && profileId && advertiserId) {
        const name = sanitizeFloodlightName(
          yield* ownedName(
            id,
            olds?.name,
            parseOwnership(output?.name).text,
            MAX_FLOODLIGHT_NAME_LENGTH,
          ),
        );
        existing = yield* findOwned(profileId, advertiserId, name);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, profileId);
      return (yield* ownedByAlchemy(id, ownershipText(existing)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      eachProfile((profileId) =>
        Effect.gen(function* () {
          const advertiserIds = yield* listAdvertiserIds(profileId);
          const pages = yield* Effect.forEach(
            advertiserIds,
            (advertiserId) => listFloodlightActivities(profileId, advertiserId),
            { concurrency: 4 },
          );
          const seen = new Set<string>();
          const attrs = [];
          for (const rows of pages) {
            for (const row of rows) {
              const activityId = row.id ?? "";
              if (
                !activityId ||
                seen.has(activityId) ||
                !(hasOwnershipMarker(row.name) || hasOwnershipMarker(row.notes))
              ) {
                continue;
              }
              seen.add(activityId);
              attrs.push(toAttrs(row, profileId));
            }
          }
          return attrs;
        }),
      ),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const profileId = news.profileId;
      const labels = yield* createInternalLabels(id);
      const name = sanitizeFloodlightName(
        yield* ownedName(
          id,
          news.name,
          parseOwnership(output?.name).text,
          MAX_FLOODLIGHT_NAME_LENGTH,
        ),
      );
      const notes = encodeOwnership(labels, news.notes);
      const countingMethod = news.countingMethod ?? DEFAULT_COUNTING;
      const floodlightTagType = news.floodlightTagType ?? DEFAULT_TAG_TYPE;
      const conversionCategory = news.conversionCategory ?? DEFAULT_CATEGORY;
      const status = news.status ?? DEFAULT_STATUS;
      const advertiserId = news.advertiserId ?? advertiserIdFromEnv();
      const floodlightActivityGroupId =
        news.floodlightActivityGroupId ||
        floodlightActivityGroupIdFromEnv() ||
        "";
      const body: dfa.FloodlightActivity = {
        floodlightActivityGroupId,
        advertiserId: news.advertiserId,
        floodlightConfigurationId: news.floodlightConfigurationId,
        name,
        notes,
        countingMethod,
        floodlightTagType,
        conversionCategory,
        status,
        expectedUrl: news.expectedUrl,
        tagString: news.tagString,
        tagFormat: news.tagFormat,
        cacheBustingType: news.cacheBustingType,
        secure: news.secure,
        sslRequired: news.sslRequired,
        attributionEnabled: news.attributionEnabled,
        userDefinedVariableTypes: news.userDefinedVariableTypes,
        defaultTags: news.defaultTags,
        publisherTags: news.publisherTags,
      };

      let current = yield* getById(profileId, news.id ?? output?.id);
      if (current === undefined) {
        current = yield* findOwned(profileId, advertiserId, name);
      }

      if (current === undefined) {
        const created = yield* dfa
          .insertFloodlightActivities({
            profileId,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwned(profileId, advertiserId, name),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new FloodlightActivityNotResolved({
          profileId,
          id: news.id ?? output?.id ?? name,
        });
      }

      const activityId = current.id ?? "";
      const changed =
        !sameText(current.name, name) ||
        !sameText(current.notes, notes) ||
        !sameText(current.countingMethod, countingMethod) ||
        !sameText(current.floodlightTagType, floodlightTagType) ||
        !sameText(current.conversionCategory, conversionCategory) ||
        !sameText(current.status, status) ||
        !sameText(current.expectedUrl, news.expectedUrl) ||
        !sameText(current.tagFormat, news.tagFormat) ||
        !sameText(current.cacheBustingType, news.cacheBustingType) ||
        !sameBool(current.secure, news.secure) ||
        !sameBool(current.sslRequired, news.sslRequired) ||
        !sameBool(current.attributionEnabled, news.attributionEnabled) ||
        !jsonEqual(
          current.userDefinedVariableTypes,
          news.userDefinedVariableTypes,
        ) ||
        !jsonEqual(current.defaultTags, news.defaultTags) ||
        !jsonEqual(current.publisherTags, news.publisherTags);
      if (changed) {
        current = yield* dfa.patchFloodlightActivities({
          profileId,
          id: activityId,
          body: { ...body, id: activityId },
        });
      }

      return toAttrs(current, profileId);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.profileId || !output.id) return;
      yield* dfa
        .deleteFloodlightActivities({
          profileId: output.profileId,
          id: output.id,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
