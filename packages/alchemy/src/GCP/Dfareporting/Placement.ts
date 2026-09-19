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
  campaignIdFromEnv,
  eachProfile,
  findByName,
  hasOwnershipMarker,
  listPlacements,
  ownedByAlchemy,
  ownedName,
  parseOwnership,
  profileIdFromEnv,
  replaceIfChanged,
  sameText,
  siteIdFromEnv,
} from "./internal.ts";

export type PlacementCompatibility =
  | dfa.PlacementCompatibilityEnum
  | (string & {});

export type PlacementPaymentSource =
  | dfa.PlacementPaymentSourceEnum
  | (string & {});

export type PlacementPricingType =
  | dfa.PricingSchedulePricingTypeEnum
  | (string & {});

export type PlacementSize = {
  /** Size id. Preferred when known. */
  id?: string;
  /** Width in pixels. */
  width?: number;
  /** Height in pixels. */
  height?: number;
};

export type PlacementPricingSchedule = {
  /**
   * Pricing type. Required on insert.
   * @default "PRICING_TYPE_CPM"
   */
  pricingType?: PlacementPricingType;
  /** Flight start date `yyyy-MM-dd`. */
  startDate?: string;
  /** Flight end date `yyyy-MM-dd`. */
  endDate?: string;
};

export type PlacementProps = {
  /**
   * Campaign Manager 360 user profile id. Immutable — changing it
   * replaces the placement.
   */
  profileId: string;
  /**
   * Campaign id. Required on insert. Immutable — changing it replaces
   * the placement.
   */
  campaignId?: string;
  /**
   * Site id. Required on insert unless `directorySiteId` is set.
   * Immutable after insert.
   */
  siteId?: string;
  /**
   * Directory site id. Required on insert unless `siteId` is set.
   * Immutable after insert.
   */
  directorySiteId?: string;
  /**
   * Advertiser id. Optional; inferred from the campaign when omitted.
   */
  advertiserId?: string;
  /**
   * System-assigned placement id. Omit on create; pass the observed id
   * to update in place.
   */
  id?: string;
  /**
   * Display name (max 512 characters). Placements have no labels field,
   * so Alchemy ownership is stored in a `[alchemy …]` prefix and
   * stripped from attributes.
   */
  name?: string;
  /**
   * Compatibility. Required on insert.
   * @default "DISPLAY"
   */
  compatibility?: PlacementCompatibility;
  /**
   * Payment source. Required on insert; read-only after.
   * @default "PLACEMENT_AGENCY_PAID"
   */
  paymentSource?: PlacementPaymentSource;
  /**
   * Size. Required on insert; only `id` is sent on write.
   * @default { width: 1, height: 1 }
   */
  size?: PlacementSize;
  /**
   * Tag formats generated for this placement. Required on insert.
   * @default ["PLACEMENT_TAG_STANDARD"]
   */
  tagFormats?: string[];
  /**
   * Pricing schedule. Required on insert (`startDate`, `endDate`,
   * `pricingType`).
   */
  pricingSchedule?: PlacementPricingSchedule;
  /**
   * Comments. Alchemy also stores an ownership marker here when `name`
   * is truncated.
   */
  comment?: string;
};

export type Placement = Resource<
  "GCP.Dfareporting.Placement",
  PlacementProps,
  {
    /** System-assigned placement id. */
    id: string;
    /** User profile id used to manage the placement. */
    profileId: string;
    /** CM360 account id. */
    accountId: string | undefined;
    /** Advertiser id. */
    advertiserId: string | undefined;
    /** Campaign id. */
    campaignId: string | undefined;
    /** Site id. */
    siteId: string | undefined;
    /** Directory site id. */
    directorySiteId: string | undefined;
    /** User display name with the Alchemy ownership prefix stripped. */
    name: string | undefined;
    /** Compatibility. */
    compatibility: string | undefined;
    /** Payment source. */
    paymentSource: string | undefined;
    /** Size. */
    size: PlacementSize | undefined;
    /** Tag formats. */
    tagFormats: string[] | undefined;
    /** Active status. */
    activeStatus: string | undefined;
    /** Pricing schedule. */
    pricingSchedule: PlacementPricingSchedule | undefined;
    /** Comments with the Alchemy ownership prefix stripped. */
    comment: string | undefined;
    /** Resource kind (`dfareporting#placement`). */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Campaign Manager 360 placement.
 *
 * Placements have no labels field — Alchemy stamps ownership into
 * `name` so `list` / nuke can find them. CM360 has no delete API;
 * Alchemy archives (`PLACEMENT_STATUS_ARCHIVED`) on destroy.
 *
 * ### Creating a Placement
 * **Example:** Display 1x1
 * ```typescript
 * const placement = yield* GCP.Dfareporting.Placement("House", {
 *   profileId: "123",
 *   campaignId: "456",
 *   siteId: "789",
 *   name: "alchemy-house",
 *   compatibility: "DISPLAY",
 *   size: { width: 1, height: 1 },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Dfareporting
 */
export const Placement = Resource<Placement>("GCP.Dfareporting.Placement");

export class PlacementNotResolved extends Data.TaggedError(
  "GCP.Dfareporting.PlacementNotResolved",
)<{
  profileId: string;
  id: string;
}> {}

const DEFAULT_COMPATIBILITY = "DISPLAY";
const DEFAULT_PAYMENT = "PLACEMENT_AGENCY_PAID";
const DEFAULT_PRICING = "PRICING_TYPE_CPM";
const DEFAULT_TAG_FORMATS = ["PLACEMENT_TAG_STANDARD"];
const ARCHIVED = "PLACEMENT_STATUS_ARCHIVED";

const defaultDates = () => {
  const start = new Date();
  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + 30);
  const iso = (value: Date) => value.toISOString().slice(0, 10);
  return { startDate: iso(start), endDate: iso(end) };
};

const sizeOf = (size: PlacementSize | undefined): dfa.Size => ({
  id: size?.id,
  width: size?.width ?? 1,
  height: size?.height ?? 1,
});

const pricingOf = (
  schedule: PlacementPricingSchedule | undefined,
): dfa.PricingSchedule => {
  const dates = defaultDates();
  return {
    pricingType: schedule?.pricingType ?? DEFAULT_PRICING,
    startDate: schedule?.startDate ?? dates.startDate,
    endDate: schedule?.endDate ?? dates.endDate,
  };
};

const toAttrs = (placement: dfa.Placement, profileId: string) => ({
  id: placement.id ?? "",
  profileId,
  accountId: placement.accountId,
  advertiserId: placement.advertiserId,
  campaignId: placement.campaignId,
  siteId: placement.siteId,
  directorySiteId: placement.directorySiteId,
  name: parseOwnership(placement.name).text,
  compatibility: placement.compatibility,
  paymentSource: placement.paymentSource,
  size: placement.size
    ? {
        id: placement.size.id,
        width: placement.size.width,
        height: placement.size.height,
      }
    : undefined,
  tagFormats: placement.tagFormats,
  activeStatus: placement.activeStatus,
  pricingSchedule: placement.pricingSchedule
    ? {
        pricingType: placement.pricingSchedule.pricingType,
        startDate: placement.pricingSchedule.startDate,
        endDate: placement.pricingSchedule.endDate,
      }
    : undefined,
  comment: parseOwnership(placement.comment).text,
  kind: placement.kind,
});

const getById = (profileId: string, id: string | undefined) =>
  !profileId || !id
    ? Effect.succeed(undefined)
    : dfa
        .getPlacements({ profileId, id })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findOwned = (profileId: string, name: string) =>
  listPlacements(profileId, { searchString: "alchemy" }).pipe(
    Effect.map((placements) => findByName(placements, name)),
  );

export const PlacementProvider = () =>
  Provider.succeed(Placement, {
    stables: ["id", "profileId", "accountId", "campaignId", "siteId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return (
        replaceIfChanged(
          olds?.profileId ?? output?.profileId,
          news.profileId,
        ) ??
        replaceIfChanged(olds?.id ?? output?.id, news.id, true) ??
        replaceIfChanged(
          olds?.campaignId ?? output?.campaignId,
          news.campaignId,
          true,
        ) ??
        replaceIfChanged(olds?.siteId ?? output?.siteId, news.siteId, true)
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
      if (
        existing.activeStatus === ARCHIVED ||
        existing.activeStatus === "PLACEMENT_STATUS_PERMANENTLY_ARCHIVED"
      ) {
        return undefined;
      }
      const attrs = toAttrs(existing, profileId);
      return (yield* ownedByAlchemy(id, existing.name))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      eachProfile((profileId) =>
        listPlacements(profileId, { searchString: "alchemy" }).pipe(
          Effect.map((rows) =>
            rows
              .filter(
                (row) =>
                  hasOwnershipMarker(row.name) &&
                  row.activeStatus !== ARCHIVED &&
                  row.activeStatus !== "PLACEMENT_STATUS_PERMANENTLY_ARCHIVED",
              )
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
      const campaignId =
        news.campaignId ?? output?.campaignId ?? campaignIdFromEnv();
      const siteId = news.siteId ?? output?.siteId ?? siteIdFromEnv();
      const directorySiteId = news.directorySiteId ?? output?.directorySiteId;
      const advertiserId =
        news.advertiserId ?? output?.advertiserId ?? advertiserIdFromEnv();

      let current = yield* getById(profileId, news.id ?? output?.id);
      if (current === undefined) {
        current = yield* findOwned(profileId, name);
      }

      if (current === undefined) {
        const created = yield* dfa
          .insertPlacements({
            profileId,
            body: {
              name,
              campaignId,
              siteId,
              directorySiteId,
              advertiserId,
              compatibility: news.compatibility ?? DEFAULT_COMPATIBILITY,
              paymentSource: news.paymentSource ?? DEFAULT_PAYMENT,
              size: sizeOf(news.size),
              tagFormats: news.tagFormats ?? DEFAULT_TAG_FORMATS,
              pricingSchedule: pricingOf(news.pricingSchedule),
              comment: news.comment,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => findOwned(profileId, name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new PlacementNotResolved({
          profileId,
          id: news.id ?? output?.id ?? name,
        });
      }

      const placementId = current.id ?? "";
      const nameChanged = !sameText(current.name, name);
      const commentChanged =
        news.comment !== undefined &&
        parseOwnership(current.comment).text !== news.comment;
      if (nameChanged || commentChanged) {
        current = yield* dfa.patchPlacements({
          profileId,
          id: placementId,
          body: {
            id: placementId,
            name,
            comment: news.comment ?? current.comment,
          },
        });
      }

      return toAttrs(current, profileId);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.profileId || !output.id) return;
      yield* dfa
        .patchPlacements({
          profileId: output.profileId,
          id: output.id,
          body: { id: output.id, activeStatus: ARCHIVED },
        })
        .pipe(Effect.catchTag(["NotFound", "Forbidden"], () => Effect.void));
    }),
  });
