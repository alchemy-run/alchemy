import * as dv from "@distilled.cloud/gcp/displayvideo_v4";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnershipLine,
  hasOwnershipMarker,
  ignoreList,
  jsonEqual,
  listAccessibleAdvertiserIds,
  listAccessiblePartnerIds,
  ownedByAlchemy,
  parseOwnership,
  sameText,
  toDisplayName,
  updateMaskOf,
} from "./ownership.ts";

const DEFAULT_TYPE = "INVENTORY_SOURCE_TYPE_PRIVATE";
const DEFAULT_COMMITMENT = "INVENTORY_SOURCE_COMMITMENT_NON_GUARANTEED";
const DEFAULT_DELIVERY = "INVENTORY_SOURCE_DELIVERY_METHOD_PROGRAMMATIC";
const DEFAULT_RATE_TYPE = "INVENTORY_SOURCE_RATE_TYPE_CPM_FLOOR";
const DEFAULT_STATUS = "ENTITY_STATUS_ACTIVE";
const ARCHIVED = "ENTITY_STATUS_ARCHIVED";

export type InventorySourceMoney = {
  /** ISO 4217 currency code. */
  currencyCode?: string;
  /** Whole units of the amount. */
  units?: string;
  /** Nano (10^-9) units of the amount. */
  nanos?: number;
};

export type InventorySourceRateDetails = {
  /** Rate charged for the inventory source. */
  rate?: InventorySourceMoney;
  /**
   * Rate type, for example `INVENTORY_SOURCE_RATE_TYPE_CPM_FLOOR`.
   * @default "INVENTORY_SOURCE_RATE_TYPE_CPM_FLOOR"
   */
  inventorySourceRateType?: string;
  /** Impressions guaranteed by the seller. Required for guaranteed sources. */
  unitsPurchased?: string;
};

export type InventorySourceTimeRange = {
  /** Inclusive start as RFC3339. */
  startTime?: string;
  /** Inclusive end as RFC3339. */
  endTime?: string;
};

export type InventorySourceStatusValue = {
  /**
   * Serving status. Accepts `ENTITY_STATUS_ACTIVE`,
   * `ENTITY_STATUS_PAUSED`, and `ENTITY_STATUS_ARCHIVED`.
   * @default "ENTITY_STATUS_ACTIVE"
   */
  entityStatus?: string;
  /** Pause reason. Only used when `entityStatus` is `ENTITY_STATUS_PAUSED`. */
  entityPauseReason?: string;
};

export type InventorySourceAccessorsValue = {
  /** Partner with read/write access. */
  partner?: { partnerId?: string };
  /** Advertisers with read/write access. Must share a partner. */
  advertisers?: { advertiserIds?: string[] };
};

export type InventorySourceCreativeConfigValue = {
  /** `CREATIVE_TYPE_STANDARD` or `CREATIVE_TYPE_VIDEO`. */
  creativeType?: string;
  /** Display size requirements. */
  displayCreativeConfig?: {
    creativeSize?: { widthPixels?: number; heightPixels?: number };
  };
  /** Video duration requirement as a duration string. */
  videoCreativeConfig?: { duration?: string };
};

export type InventorySourceProps = {
  /**
   * Partner the request is made within. Mutually exclusive with
   * `advertiserId` as the write owner for non-guaranteed sources.
   */
  partnerId?: string;
  /**
   * Advertiser the request is made within. Mutually exclusive with
   * `partnerId` as the write owner for non-guaranteed sources.
   */
  advertiserId?: string;
  /**
   * System-assigned inventory source id. Omit on create; pass the
   * observed id to update in place.
   */
  inventorySourceId?: string;
  /**
   * Display name (max 240 bytes). Inventory sources have no labels
   * field, so Alchemy ownership is stored in a `[alchemy …]` prefix
   * and stripped from attributes.
   */
  displayName?: string;
  /**
   * Inventory source type. Immutable.
   * @default "INVENTORY_SOURCE_TYPE_PRIVATE"
   */
  inventorySourceType?: string;
  /**
   * Guaranteed vs non-guaranteed delivery. Immutable.
   * @default "INVENTORY_SOURCE_COMMITMENT_NON_GUARANTEED"
   */
  commitment?: string;
  /**
   * Delivery method.
   * @default "INVENTORY_SOURCE_DELIVERY_METHOD_PROGRAMMATIC"
   */
  deliveryMethod?: string;
  /**
   * Exchange-space deal id. Generated when omitted.
   */
  dealId?: string;
  /**
   * Exchange the inventory belongs to, for example
   * `EXCHANGE_GOOGLE_AD_MANAGER`.
   */
  exchange?: string;
  /**
   * Rate details. Defaults to a $1 CPM floor in USD.
   */
  rateDetails?: InventorySourceRateDetails;
  /**
   * Serving window.
   */
  timeRange?: InventorySourceTimeRange;
  /**
   * Serving status. Destroy archives the source (`ENTITY_STATUS_ARCHIVED`)
   * because DV360 has no inventory-source delete.
   */
  status?: InventorySourceStatusValue;
  /**
   * Partner or advertisers with read/write access. Required for
   * non-guaranteed sources. Defaults from `partnerId` / `advertiserId`.
   */
  readWriteAccessors?: InventorySourceAccessorsValue;
  /**
   * Creative requirements. Not applicable for auction packages.
   */
  creativeConfigs?: InventorySourceCreativeConfigValue[];
  /**
   * Publisher / seller name.
   */
  publisherName?: string;
  /**
   * Parent guaranteed order. Immutable. Only for guaranteed sources.
   */
  guaranteedOrderId?: string;
};

export type InventorySource = Resource<
  "GCP.Displayvideo.InventorySource",
  InventorySourceProps,
  {
    /** Resource name `inventorySources/{inventorySource}`. */
    name: string;
    /** System-assigned inventory source id. */
    inventorySourceId: string;
    /** Partner the request was made within. */
    partnerId: string | undefined;
    /** Advertiser the request was made within. */
    advertiserId: string | undefined;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Inventory source type. */
    inventorySourceType: string | undefined;
    /** Guaranteed vs non-guaranteed delivery. */
    commitment: string | undefined;
    /** Delivery method. */
    deliveryMethod: string | undefined;
    /** Exchange-space deal id. */
    dealId: string | undefined;
    /** Exchange. */
    exchange: string | undefined;
    /** Rate details. */
    rateDetails: InventorySourceRateDetails | undefined;
    /** Serving window. */
    timeRange: InventorySourceTimeRange | undefined;
    /** Serving status. */
    status: InventorySourceStatusValue | undefined;
    /** Read/write accessors. */
    readWriteAccessors: InventorySourceAccessorsValue | undefined;
    /** Creative requirements. */
    creativeConfigs: InventorySourceCreativeConfigValue[] | undefined;
    /** Publisher / seller name. */
    publisherName: string | undefined;
    /** Parent guaranteed order id. */
    guaranteedOrderId: string | undefined;
    /** Product type. */
    inventorySourceProductType: string | undefined;
    /** Partners with read-only access. */
    readPartnerIds: string[] | undefined;
    /** Advertisers with read-only access. */
    readAdvertiserIds: string[] | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Display and Video 360 inventory source.
 *
 * Sources have no labels field — Alchemy stamps ownership into the
 * display name so `list` / nuke can find them. Type, commitment, and
 * guaranteed order are immutable. Display name, rate, status, and
 * accessors update in place. The DV360 API has no inventory-source
 * delete; destroy archives the source.
 *
 * ### Creating an Inventory Source
 * **Example:** Non-guaranteed private deal
 * ```typescript
 * const source = yield* GCP.Displayvideo.InventorySource("Deal", {
 *   partnerId: "123",
 *   displayName: "premium-deal",
 *   exchange: "EXCHANGE_GOOGLE_AD_MANAGER",
 * });
 * ```
 *
 * ### Updating an Inventory Source
 * **Example:** Pause serving
 * ```typescript
 * const source = yield* GCP.Displayvideo.InventorySource("Deal", {
 *   partnerId: existing.partnerId,
 *   inventorySourceId: existing.inventorySourceId,
 *   displayName: "premium-deal",
 *   status: { entityStatus: "ENTITY_STATUS_PAUSED" },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Displayvideo
 */
export const InventorySource = Resource<InventorySource>(
  "GCP.Displayvideo.InventorySource",
);

export class InventorySourceNotResolved extends Data.TaggedError(
  "GCP.Displayvideo.InventorySourceNotResolved",
)<{
  inventorySourceId: string;
}> {}

type Owner = { partnerId?: string; advertiserId?: string };

const ownerOf = (props: Owner): Owner => ({
  partnerId: props.partnerId,
  advertiserId: props.advertiserId,
});

const defaultAccessors = (owner: Owner): InventorySourceAccessorsValue =>
  owner.partnerId
    ? { partner: { partnerId: owner.partnerId } }
    : owner.advertiserId
      ? { advertisers: { advertiserIds: [owner.advertiserId] } }
      : {};

const defaultRate = (): InventorySourceRateDetails => ({
  inventorySourceRateType: DEFAULT_RATE_TYPE,
  rate: { currencyCode: "USD", units: "1" },
});

const rateKey = (
  rate: dv.RateDetails | InventorySourceRateDetails | undefined,
) => ({
  inventorySourceRateType: rate?.inventorySourceRateType,
  unitsPurchased: rate?.unitsPurchased,
  rate: rate?.rate
    ? {
        currencyCode: rate.rate.currencyCode,
        units: rate.rate.units,
        nanos: rate.rate.nanos,
      }
    : undefined,
});

const toAttrs = (source: dv.InventorySource, owner: Owner) => {
  const parsed = parseOwnership(source.displayName);
  return {
    name: source.name ?? "",
    inventorySourceId: source.inventorySourceId ?? "",
    partnerId: owner.partnerId,
    advertiserId: owner.advertiserId,
    displayName: parsed.text,
    inventorySourceType: source.inventorySourceType,
    commitment: source.commitment,
    deliveryMethod: source.deliveryMethod,
    dealId: source.dealId,
    exchange: source.exchange,
    rateDetails: source.rateDetails,
    timeRange: source.timeRange,
    status: source.status
      ? {
          entityStatus: source.status.entityStatus,
          entityPauseReason: source.status.entityPauseReason,
        }
      : undefined,
    readWriteAccessors: source.readWriteAccessors,
    creativeConfigs: source.creativeConfigs,
    publisherName: source.publisherName,
    guaranteedOrderId: source.guaranteedOrderId,
    inventorySourceProductType: source.inventorySourceProductType,
    readPartnerIds: source.readPartnerIds,
    readAdvertiserIds: source.readAdvertiserIds,
    updateTime: source.updateTime,
  };
};

const getById = (inventorySourceId: string | undefined, owner: Owner) =>
  !inventorySourceId
    ? Effect.succeed(undefined)
    : dv
        .getInventorySources({
          inventorySourceId,
          partnerId: owner.partnerId,
          advertiserId: owner.advertiserId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (owner: Owner) =>
  dv.listInventorySources
    .pages({
      partnerId: owner.partnerId,
      advertiserId: owner.advertiserId,
      pageSize: 200,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.inventorySources ?? []),
      ),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      ignoreList([] as dv.InventorySource[]),
    );

const findByDisplayName = (owner: Owner, displayName: string) =>
  listAt(owner).pipe(
    Effect.map((sources) =>
      sources.find((source) => source.displayName === displayName),
    ),
  );

export const InventorySourceProvider = () =>
  Provider.succeed(InventorySource, {
    stables: [
      "name",
      "inventorySourceId",
      "partnerId",
      "advertiserId",
      "inventorySourceType",
      "commitment",
      "guaranteedOrderId",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousPartner = olds?.partnerId ?? output?.partnerId;
      const previousAdvertiser = olds?.advertiserId ?? output?.advertiserId;
      if (
        (previousPartner !== undefined &&
          (news.partnerId ?? "") !== (previousPartner ?? "")) ||
        (previousAdvertiser !== undefined &&
          (news.advertiserId ?? "") !== (previousAdvertiser ?? ""))
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousType =
        olds?.inventorySourceType ??
        output?.inventorySourceType ??
        DEFAULT_TYPE;
      const nextType = news.inventorySourceType ?? DEFAULT_TYPE;
      if (previousType !== nextType) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousCommitment =
        olds?.commitment ?? output?.commitment ?? DEFAULT_COMMITMENT;
      const nextCommitment = news.commitment ?? DEFAULT_COMMITMENT;
      if (previousCommitment !== nextCommitment) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousOrder =
        olds?.guaranteedOrderId ?? output?.guaranteedOrderId;
      if (
        previousOrder !== undefined &&
        news.guaranteedOrderId !== undefined &&
        news.guaranteedOrderId !== previousOrder
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.inventorySourceId ?? output?.inventorySourceId;
      if (
        previousId !== undefined &&
        news.inventorySourceId !== undefined &&
        news.inventorySourceId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const owner = ownerOf({
        partnerId: olds?.partnerId ?? output?.partnerId,
        advertiserId: olds?.advertiserId ?? output?.advertiserId,
      });
      let existing = yield* getById(
        olds?.inventorySourceId ?? output?.inventorySourceId,
        owner,
      );
      if (existing === undefined && (owner.partnerId || owner.advertiserId)) {
        const ownership = yield* createInternalLabels(id);
        existing = yield* findByDisplayName(
          owner,
          encodeOwnershipLine(ownership, olds?.displayName),
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, owner);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const seen = new Set<string>();
        const owners: Owner[] = [];
        const partnerIds = yield* listAccessiblePartnerIds();
        for (const partnerId of partnerIds) owners.push({ partnerId });
        const advertiserIds = yield* listAccessibleAdvertiserIds();
        for (const advertiserId of advertiserIds) owners.push({ advertiserId });
        const pages = yield* Effect.forEach(owners, (owner) => listAt(owner), {
          concurrency: 4,
        });
        const attrs = [];
        for (let i = 0; i < pages.length; i++) {
          const owner = owners[i]!;
          for (const source of pages[i] ?? []) {
            const id = source.inventorySourceId ?? "";
            if (
              !id ||
              seen.has(id) ||
              !hasOwnershipMarker(source.displayName) ||
              source.status?.entityStatus === ARCHIVED
            ) {
              continue;
            }
            seen.add(id);
            attrs.push(toAttrs(source, owner));
          }
        }
        return attrs;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const owner = ownerOf(news);
      const ownership = yield* createInternalLabels(id);
      const userName = yield* toDisplayName(
        id,
        news.displayName,
        parseOwnership(output?.displayName).text,
      );
      const displayName = encodeOwnershipLine(ownership, userName);
      const dealId =
        news.dealId ??
        output?.dealId ??
        (yield* toDisplayName(id, undefined, undefined));
      const inventorySourceType = news.inventorySourceType ?? DEFAULT_TYPE;
      const commitment = news.commitment ?? DEFAULT_COMMITMENT;
      const deliveryMethod = news.deliveryMethod ?? DEFAULT_DELIVERY;
      const rateDetails = news.rateDetails ?? defaultRate();
      const readWriteAccessors =
        news.readWriteAccessors ?? defaultAccessors(owner);
      const entityStatus = news.status?.entityStatus ?? DEFAULT_STATUS;
      const status = {
        entityStatus,
        entityPauseReason: news.status?.entityPauseReason,
      };

      let current = yield* getById(
        news.inventorySourceId ?? output?.inventorySourceId,
        owner,
      );
      if (current === undefined) {
        current = yield* findByDisplayName(owner, displayName);
      }

      if (current === undefined) {
        const created = yield* dv
          .createInventorySources({
            partnerId: owner.partnerId,
            advertiserId: owner.advertiserId,
            body: {
              displayName,
              inventorySourceType,
              commitment,
              deliveryMethod,
              dealId,
              exchange: news.exchange,
              rateDetails,
              timeRange: news.timeRange,
              status,
              readWriteAccessors,
              creativeConfigs: news.creativeConfigs,
              publisherName: news.publisherName,
              guaranteedOrderId: news.guaranteedOrderId,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findByDisplayName(owner, displayName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new InventorySourceNotResolved({
          inventorySourceId:
            news.inventorySourceId ?? output?.inventorySourceId ?? displayName,
        });
      }

      const inventorySourceId = current.inventorySourceId ?? "";
      const displayChanged = !sameText(current.displayName, displayName);
      const statusChanged =
        (current.status?.entityStatus ?? "") !== entityStatus ||
        !sameText(
          current.status?.entityPauseReason,
          news.status?.entityPauseReason,
        );
      const rateChanged = !jsonEqual(
        rateKey(current.rateDetails),
        rateKey(rateDetails),
      );
      const rangeChanged = !jsonEqual(current.timeRange, news.timeRange);
      const accessorsChanged = !jsonEqual(
        current.readWriteAccessors,
        readWriteAccessors,
      );
      const creativeChanged = !jsonEqual(
        current.creativeConfigs,
        news.creativeConfigs,
      );
      const publisherChanged = !sameText(
        current.publisherName,
        news.publisherName,
      );
      const dealChanged = !sameText(current.dealId, dealId);
      const deliveryChanged = !sameText(current.deliveryMethod, deliveryMethod);
      const exchangeChanged =
        news.exchange !== undefined &&
        !sameText(current.exchange, news.exchange);

      if (
        displayChanged ||
        statusChanged ||
        rateChanged ||
        rangeChanged ||
        accessorsChanged ||
        creativeChanged ||
        publisherChanged ||
        dealChanged ||
        deliveryChanged ||
        exchangeChanged
      ) {
        current = yield* dv.patchInventorySources({
          inventorySourceId,
          partnerId: owner.partnerId,
          advertiserId: owner.advertiserId,
          updateMask: updateMaskOf(
            displayChanged ? "displayName" : undefined,
            statusChanged ? "status" : undefined,
            rateChanged ? "rateDetails" : undefined,
            rangeChanged ? "timeRange" : undefined,
            accessorsChanged ? "readWriteAccessors" : undefined,
            creativeChanged ? "creativeConfigs" : undefined,
            publisherChanged ? "publisherName" : undefined,
            dealChanged ? "dealId" : undefined,
            deliveryChanged ? "deliveryMethod" : undefined,
            exchangeChanged ? "exchange" : undefined,
          ),
          body: {
            inventorySourceId,
            displayName,
            deliveryMethod,
            dealId,
            exchange: news.exchange,
            rateDetails,
            timeRange: news.timeRange,
            status,
            readWriteAccessors,
            creativeConfigs: news.creativeConfigs,
            publisherName: news.publisherName,
          },
        });
      }

      return toAttrs(current, owner);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.inventorySourceId) return;
      // DV360 has no InventorySources.delete. Archive so list / nuke skip it.
      yield* dv
        .patchInventorySources({
          inventorySourceId: output.inventorySourceId,
          partnerId: output.partnerId,
          advertiserId: output.advertiserId,
          updateMask: updateMaskOf("status.entityStatus"),
          body: {
            inventorySourceId: output.inventorySourceId,
            status: { entityStatus: ARCHIVED },
          },
        })
        .pipe(
          Effect.catchTag(
            ["NotFound", "Forbidden"] as const,
            () => Effect.void,
          ),
        );
    }),
  });
