import * as content from "@distilled.cloud/gcp/content_v2_1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnershipLine,
  findOwnedPos,
  getPosStore,
  hasOwnershipMarker,
  jsonEqual,
  listOwnedPos,
  MAX_STORE_NAME_LENGTH,
  ownedByAlchemy,
  parseOwnership,
  sameStringList,
  sameText,
  targetMerchantIdFromEnv,
  toResourceId,
} from "./internal.ts";

export type PoProps = {
  /**
   * Merchant Center account id of the POS or inventory data provider.
   * Immutable — changing it replaces the store.
   */
  merchantId: string;
  /**
   * Merchant Center account that owns the store. Defaults to
   * `merchantId`. Immutable — changing it replaces the store.
   */
  targetMerchantId?: string;
  /**
   * Store code unique to the merchant. If omitted, a unique code is
   * generated from the stack, stage, and logical id. Immutable —
   * changing it replaces the store.
   */
  storeCode?: string;
  /**
   * Merchant or store name. POS stores have no labels field, so Alchemy
   * ownership is stored in a `[alchemy …]` prefix and stripped from
   * attributes.
   */
  storeName?: string;
  /**
   * Street address of the store.
   */
  storeAddress: string;
  /**
   * Store phone number.
   */
  phoneNumber?: string;
  /**
   * Website URL for the store or merchant.
   */
  websiteUrl?: string;
  /**
   * Google Place id of the store location.
   */
  placeId?: string;
  /**
   * Business type of the store (GCID categories).
   */
  gcidCategory?: string[];
};

export type Po = Resource<
  "GCP.Content.Po",
  PoProps,
  {
    /** POS or inventory data provider merchant id. */
    merchantId: string;
    /** Target merchant id. */
    targetMerchantId: string;
    /** Store code unique to the merchant. */
    storeCode: string;
    /** User store name with the Alchemy ownership prefix stripped. */
    storeName: string | undefined;
    /** Street address. */
    storeAddress: string | undefined;
    /** Store phone number. */
    phoneNumber: string | undefined;
    /** Website URL. */
    websiteUrl: string | undefined;
    /** Google Place id. */
    placeId: string | undefined;
    /** GCID categories. */
    gcidCategory: string[];
    /** Matching status against Google Business Profile. */
    matchingStatus: string | undefined;
    /** Hint when matching failed. */
    matchingStatusHint: string | undefined;
    /** Resource kind (`content#posStore`). */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Merchant Center point-of-sale store (Content API for Shopping).
 *
 * POS stores have no labels field, so Alchemy stamps ownership into
 * `storeName` for `list` / nuke. `merchantId`, `targetMerchantId`, and
 * `storeCode` are identity — changing them replaces the store. Address,
 * phone, website, place id, and categories update in place (delete then
 * insert; the POS API has no patch). Creating a store requires a
 * Merchant Center account with POS access.
 *
 * ### Creating a Store
 * **Example:** Generated store code
 * ```typescript
 * const store = yield* GCP.Content.Po("Downtown", {
 *   merchantId: "123456",
 *   storeAddress: "123 Main St, Springfield, IL 62701",
 *   storeName: "Downtown",
 * });
 * ```
 *
 * **Example:** Explicit store code and phone
 * ```typescript
 * const store = yield* GCP.Content.Po("Downtown", {
 *   merchantId: "123456",
 *   storeCode: "dt-01",
 *   storeAddress: "123 Main St, Springfield, IL 62701",
 *   storeName: "Downtown",
 *   phoneNumber: "+1-217-555-0100",
 * });
 * ```
 *
 * ### Updating a Store
 * **Example:** Change the display name and phone
 * ```typescript
 * const store = yield* GCP.Content.Po("Downtown", {
 *   merchantId: existing.merchantId,
 *   storeCode: existing.storeCode,
 *   storeAddress: "123 Main St, Springfield, IL 62701",
 *   storeName: "Downtown flagship",
 *   phoneNumber: "+1-217-555-0199",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Content
 */
export const Po = Resource<Po>("GCP.Content.Po");

export class PoNotResolved extends Data.TaggedError(
  "GCP.Content.PoNotResolved",
)<{
  storeCode: string;
}> {}

const toAttrs = (
  store: content.PosStore,
  merchantId: string,
  targetMerchantId: string,
) => {
  const parsed = parseOwnership(store.storeName);
  return {
    merchantId,
    targetMerchantId,
    storeCode: store.storeCode ?? "",
    storeName: parsed.text,
    storeAddress: store.storeAddress,
    phoneNumber: store.phoneNumber,
    websiteUrl: store.websiteUrl,
    placeId: store.placeId,
    gcidCategory: store.gcidCategory ?? [],
    matchingStatus: store.matchingStatus,
    matchingStatusHint: store.matchingStatusHint,
    kind: store.kind,
  };
};

const desiredStore = (input: {
  storeCode: string;
  storeName: string;
  storeAddress: string;
  phoneNumber?: string;
  websiteUrl?: string;
  placeId?: string;
  gcidCategory?: string[];
}): content.PosStore => ({
  storeCode: input.storeCode,
  storeName: input.storeName,
  storeAddress: input.storeAddress,
  phoneNumber: input.phoneNumber,
  websiteUrl: input.websiteUrl,
  placeId: input.placeId,
  gcidCategory: input.gcidCategory,
});

const storeNeedsSync = (current: content.PosStore, desired: content.PosStore) =>
  !sameText(current.storeName, desired.storeName) ||
  !sameText(current.storeAddress, desired.storeAddress) ||
  !sameText(current.phoneNumber, desired.phoneNumber) ||
  !sameText(current.websiteUrl, desired.websiteUrl) ||
  !sameText(current.placeId, desired.placeId) ||
  !sameStringList(current.gcidCategory, desired.gcidCategory) ||
  !jsonEqual(current.gcidCategory ?? [], desired.gcidCategory ?? []);

export const PoProvider = () =>
  Provider.succeed(Po, {
    stables: ["merchantId", "targetMerchantId", "storeCode"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousMerchant = olds?.merchantId ?? output?.merchantId;
      if (
        previousMerchant !== undefined &&
        news.merchantId !== previousMerchant
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousTarget =
        olds?.targetMerchantId ?? output?.targetMerchantId ?? previousMerchant;
      const nextTarget = news.targetMerchantId ?? news.merchantId;
      if (previousTarget !== undefined && nextTarget !== previousTarget) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousCode = olds?.storeCode ?? output?.storeCode;
      if (
        previousCode !== undefined &&
        news.storeCode !== undefined &&
        news.storeCode !== previousCode
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const merchantId = olds?.merchantId ?? output?.merchantId ?? "";
      const targetMerchantId =
        olds?.targetMerchantId ?? output?.targetMerchantId ?? merchantId;
      const storeCode = yield* toResourceId(
        id,
        olds?.storeCode,
        output?.storeCode,
      );
      let existing = yield* getPosStore(
        merchantId,
        targetMerchantId,
        output?.storeCode ?? storeCode,
      );
      if (existing === undefined && merchantId) {
        existing = yield* findOwnedPos(
          id,
          merchantId,
          targetMerchantId,
          storeCode,
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, merchantId, targetMerchantId);
      return (yield* ownedByAlchemy(id, existing.storeName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const rows = yield* listOwnedPos();
        return rows
          .filter((row) => hasOwnershipMarker(row.store.storeName))
          .map((row) =>
            toAttrs(row.store, row.merchantId, row.targetMerchantId),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const merchantId = news.merchantId;
      const targetMerchantId =
        news.targetMerchantId ?? output?.targetMerchantId ?? merchantId;
      const storeCode = yield* toResourceId(
        id,
        news.storeCode,
        output?.storeCode,
      );
      const ownership = yield* createInternalLabels(id);
      const userName = yield* toResourceId(
        id,
        news.storeName,
        parseOwnership(output?.storeName).text,
        40,
      );
      const storeName = encodeOwnershipLine(
        ownership,
        userName,
        MAX_STORE_NAME_LENGTH,
      );
      const desired = desiredStore({
        storeCode,
        storeName,
        storeAddress: news.storeAddress,
        phoneNumber: news.phoneNumber,
        websiteUrl: news.websiteUrl,
        placeId: news.placeId,
        gcidCategory: news.gcidCategory,
      });

      let current = yield* getPosStore(
        merchantId,
        targetMerchantId,
        output?.storeCode ?? storeCode,
      );
      if (current === undefined) {
        current = yield* findOwnedPos(
          id,
          merchantId,
          targetMerchantId,
          storeCode,
        );
      }

      const insert = () =>
        content
          .insertPos({
            merchantId,
            targetMerchantId,
            body: desired,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getPosStore(merchantId, targetMerchantId, storeCode),
            ),
          );

      if (current === undefined) {
        current = (yield* insert()) ?? undefined;
      } else if (storeNeedsSync(current, desired)) {
        yield* content
          .deletePos({
            merchantId,
            targetMerchantId,
            storeCode: current.storeCode ?? storeCode,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        current = (yield* insert()) ?? undefined;
      }

      if (current === undefined) {
        return yield* new PoNotResolved({ storeCode });
      }

      return toAttrs(current, merchantId, targetMerchantId);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.storeCode) return;
      const targetMerchantId =
        output.targetMerchantId ||
        targetMerchantIdFromEnv() ||
        output.merchantId;
      yield* content
        .deletePos({
          merchantId: output.merchantId,
          targetMerchantId,
          storeCode: output.storeCode,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.catchTag("Forbidden", () => Effect.void),
        );
    }),
  });
