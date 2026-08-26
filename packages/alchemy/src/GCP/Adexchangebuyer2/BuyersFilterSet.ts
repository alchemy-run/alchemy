import * as adex from "@distilled.cloud/gcp/adexchangebuyer2_v2beta1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  buyerOwnersFromEnv,
  collectFilterSets,
  expandBuyer,
  findOwnedFilterSet,
  hasOwnershipMarker,
  lastSegment,
  ownedByAlchemy,
  ownerNameOf,
  replaceOnIdentity,
  resourceName,
  specChanged,
  specOf,
  toFilterSetAttrs,
  toFilterSetBody,
  toFilterSetId,
  type AbsoluteDateRangeValue,
  type RealtimeTimeRangeValue,
  type RelativeDateRangeValue,
} from "./internal.ts";

export type BuyersFilterSetProps = {
  /**
   * Owner buyer, as `buyers/{buyer}` or the buyer account id. Immutable
   * — changing it replaces the filter set.
   */
  ownerName: string;
  /**
   * Filter set id (last path segment). If omitted, a unique id is
   * generated from the stack, stage, and logical id. Filter sets have no
   * labels field, so Alchemy stamps ownership into this id (`alch.…`)
   * and uses it for `list` / nuke. Immutable — changing it replaces the
   * filter set.
   */
  filterSetId?: string;
  /**
   * When true, the filter set is transient (available for at least one
   * hour). Default is persistent. Immutable — changing it replaces the
   * filter set.
   * @default false
   */
  isTransient?: boolean;
  /**
   * Platforms to include (`DESKTOP`, `TABLET`, `MOBILE`). Immutable —
   * changing it replaces the filter set.
   */
  platforms?: string[];
  /**
   * Time-series granularity (`HOURLY` or `DAILY`). Immutable — changing
   * it replaces the filter set.
   */
  timeSeriesGranularity?: string;
  /**
   * Environment to include (`WEB` or `APP`). Immutable — changing it
   * replaces the filter set.
   */
  environment?: string;
  /**
   * Creative formats. The API accepts at most one value. Immutable —
   * changing it replaces the filter set.
   */
  formats?: string[];
  /**
   * Creative format. Immutable — changing it replaces the filter set.
   */
  format?: string;
  /**
   * Absolute date range (Pacific time, last 30 days). Immutable —
   * changing it replaces the filter set.
   */
  absoluteDateRange?: AbsoluteDateRangeValue;
  /**
   * Breakdown dimensions (`PUBLISHER_IDENTIFIER`). Immutable — changing
   * it replaces the filter set.
   */
  breakdownDimensions?: string[];
  /**
   * Relative date range (Pacific time). When no date range is set,
   * Alchemy defaults to today (`offsetDays: 0`, `durationDays: 1`).
   * Immutable — changing it replaces the filter set.
   */
  relativeDateRange?: RelativeDateRangeValue;
  /**
   * Seller (publisher) network ids. Immutable — changing it replaces
   * the filter set.
   */
  sellerNetworkIds?: number[];
  /**
   * Open-ended realtime range. Immutable — changing it replaces the
   * filter set.
   */
  realtimeTimeRange?: RealtimeTimeRangeValue;
  /**
   * Publisher identifiers (Open Bidding). Immutable — changing it
   * replaces the filter set.
   */
  publisherIdentifiers?: string[];
};

export type BuyersFilterSet = Resource<
  "GCP.Adexchangebuyer2.BuyersFilterSet",
  BuyersFilterSetProps,
  {
    /** Full resource name `buyers/{buyer}/filterSets/{filterSet}`. */
    name: string;
    /** Filter set id (last path segment), including the Alchemy prefix. */
    filterSetId: string;
    /** Owner buyer resource name `buyers/{buyer}`. */
    ownerName: string;
    /** Project id used when the filter set was reconciled. */
    project: string;
    /** Platforms. */
    platforms: string[] | undefined;
    /** Time-series granularity. */
    timeSeriesGranularity: string | undefined;
    /** Environment. */
    environment: string | undefined;
    /** Deal id (account-level only; unused here). */
    dealId: string | undefined;
    /** Creative formats. */
    formats: string[] | undefined;
    /** Creative id (account-level only; unused here). */
    creativeId: string | undefined;
    /** Creative format. */
    format: string | undefined;
    /** Absolute date range. */
    absoluteDateRange: AbsoluteDateRangeValue | undefined;
    /** Breakdown dimensions. */
    breakdownDimensions: string[] | undefined;
    /** Relative date range. */
    relativeDateRange: RelativeDateRangeValue | undefined;
    /** Seller network ids. */
    sellerNetworkIds: number[] | undefined;
    /** Realtime range. */
    realtimeTimeRange: RealtimeTimeRangeValue | undefined;
    /** Publisher identifiers. */
    publisherIdentifiers: string[] | undefined;
  },
  never,
  Providers
>;

/**
 * A buyer-level Authorized Buyers RTB filter set
 * (`buyers/{buyer}/filterSets/{filterSet}`).
 *
 * Filter sets have no labels or description — Alchemy stamps ownership
 * into the filter set id so `list` / nuke can find them. There is no
 * update API; owner, id, and filter fields are identity and changing
 * them replaces the resource.
 *
 * ### Creating a Filter Set
 * **Example:** Generated id
 * ```typescript
 * const set = yield* GCP.Adexchangebuyer2.BuyersFilterSet("Daily", {
 *   ownerName: "buyers/123",
 *   relativeDateRange: { offsetDays: 0, durationDays: 1 },
 * });
 * ```
 *
 * **Example:** Explicit id and environment
 * ```typescript
 * const set = yield* GCP.Adexchangebuyer2.BuyersFilterSet("Daily", {
 *   ownerName: "buyers/123",
 *   filterSetId: "daily-app",
 *   environment: "APP",
 *   relativeDateRange: { offsetDays: 0, durationDays: 7 },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Adexchangebuyer2
 */
export const BuyersFilterSet = Resource<BuyersFilterSet>(
  "GCP.Adexchangebuyer2.BuyersFilterSet",
);

export class BuyersFilterSetNotResolved extends Data.TaggedError(
  "GCP.Adexchangebuyer2.BuyersFilterSetNotResolved",
)<{
  ownerName: string;
  name: string;
}> {}

const getByName = (name: string) =>
  !name
    ? Effect.succeed(undefined)
    : adex
        .getBuyersFilterSets({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (ownerName: string) =>
  ownerName.length === 0
    ? Effect.succeed([] as adex.FilterSet[])
    : collectFilterSets(
        adex.listBuyersFilterSets.pages({ ownerName, pageSize: 200 }),
      );

export const BuyersFilterSetProvider = () =>
  Provider.succeed(BuyersFilterSet, {
    stables: ["name", "filterSetId", "ownerName", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const identity = replaceOnIdentity({
        previousOwner: expandBuyer(olds?.ownerName ?? output?.ownerName ?? ""),
        nextOwner: expandBuyer(news.ownerName),
        previousId: olds?.filterSetId ?? output?.filterSetId,
        nextId: news.filterSetId,
      });
      if (identity) return identity;
      if (olds !== undefined && specChanged(specOf(olds), specOf(news))) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const ownerName = expandBuyer(olds?.ownerName ?? output?.ownerName ?? "");
      const filterSetId = yield* toFilterSetId(
        id,
        olds?.filterSetId,
        output?.filterSetId,
      );
      const name = output?.name ?? resourceName(ownerName, filterSetId);
      let existing = yield* getByName(name);
      if (existing === undefined && ownerName) {
        existing = yield* findOwnedFilterSet(
          yield* listAt(ownerName),
          id,
          name,
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toFilterSetAttrs(
        existing,
        ownerNameOf(existing.name ?? "") || ownerName,
        env.project,
      );
      return (yield* ownedByAlchemy(id, lastSegment(existing.name ?? "")))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const owners = buyerOwnersFromEnv();
        const pages = yield* Effect.forEach(
          owners,
          (ownerName) => listAt(ownerName),
          { concurrency: 4 },
        );
        return pages.flatMap((rows, index) =>
          rows
            .filter((row) => hasOwnershipMarker(lastSegment(row.name ?? "")))
            .map((row) =>
              toFilterSetAttrs(row, owners[index] ?? "", env.project),
            ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const ownerName = expandBuyer(news.ownerName);
      const filterSetId = yield* toFilterSetId(
        id,
        news.filterSetId,
        output?.filterSetId,
      );
      const name = resourceName(ownerName, filterSetId);
      const body = toFilterSetBody(name, specOf(news));

      let current = yield* getByName(
        news.filterSetId ? name : (output?.name ?? name),
      );
      if (current === undefined) {
        current = yield* findOwnedFilterSet(yield* listAt(ownerName), id, name);
      }

      if (current === undefined) {
        const created = yield* adex
          .createBuyersFilterSets({
            ownerName,
            isTransient: news.isTransient,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new BuyersFilterSetNotResolved({ ownerName, name });
      }

      return toFilterSetAttrs(current, ownerName, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* adex
        .deleteBuyersFilterSets({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
