import * as adex from "@distilled.cloud/gcp/adexchangebuyer2_v2beta1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
  sanitizeLabelValue,
} from "../Labels.ts";

export const MAX_FILTER_SET_ID_LENGTH = 63;

export const DEFAULT_RELATIVE_DATE_RANGE: RelativeDateRangeValue = {
  offsetDays: 0,
  durationDays: 1,
};

export type FilterSetDateValue = {
  year?: number;
  month?: number;
  day?: number;
};

export type AbsoluteDateRangeValue = {
  startDate?: FilterSetDateValue;
  endDate?: FilterSetDateValue;
};

export type RelativeDateRangeValue = {
  offsetDays?: number;
  durationDays?: number;
};

export type RealtimeTimeRangeValue = {
  startTimestamp?: string;
};

export type FilterSetSpec = {
  platforms?: string[];
  timeSeriesGranularity?: string;
  environment?: string;
  dealId?: string;
  formats?: string[];
  creativeId?: string;
  format?: string;
  absoluteDateRange?: AbsoluteDateRangeValue;
  breakdownDimensions?: string[];
  relativeDateRange?: RelativeDateRangeValue;
  sellerNetworkIds?: number[];
  realtimeTimeRange?: RealtimeTimeRangeValue;
  publisherIdentifiers?: string[];
  isTransient?: boolean;
};

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const ownerNameOf = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const index = parts.lastIndexOf("filterSets");
  if (index > 0) return parts.slice(0, index).join("/");
  return "";
};

export const resourceName = (ownerName: string, filterSetId: string) =>
  `${ownerName}/filterSets/${filterSetId}`;

export const expandOwner = (value: string, collection: string) => {
  const trimmed = value.replace(/\/+$/, "").trim();
  if (trimmed.length === 0) return trimmed;
  if (trimmed.includes("/")) return trimmed;
  return `${collection}/${trimmed}`;
};

export const expandBidder = (value: string) => expandOwner(value, "bidders");

export const expandBuyer = (value: string) => expandOwner(value, "buyers");

export const expandBidderAccount = (value: string, accountId?: string) => {
  const trimmed = value.replace(/\/+$/, "").trim();
  if (trimmed.includes("/accounts/")) return trimmed;
  const bidder = expandBidder(trimmed);
  const account = accountId?.trim();
  if (!account) return bidder;
  const accountPart = account.includes("/") ? lastSegment(account) : account;
  return `${bidder}/accounts/${accountPart}`;
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  jsonEqual(
    [...(left ?? [])].slice().sort(),
    [...(right ?? [])].slice().sort(),
  );

export const sameNumberList = (
  left: readonly number[] | undefined,
  right: readonly number[] | undefined,
) =>
  jsonEqual(
    [...(left ?? [])].slice().sort((a, b) => a - b),
    [...(right ?? [])].slice().sort((a, b) => a - b),
  );

export const encodeOwnershipId = (
  labels: Record<string, string>,
  extra?: string,
): string => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let rest = extra ? sanitizeLabelValue(extra) : "";
  const build = () =>
    rest.length > 0
      ? `alch.${stack}.${stage}.${id}.${rest}`
      : `alch.${stack}.${stage}.${id}`;
  let name = build();
  while (name.length > MAX_FILTER_SET_ID_LENGTH) {
    if (rest.length > 1) rest = rest.slice(0, -1);
    else if (id.length > 1) id = id.slice(0, -1);
    else if (stack.length > 1) stack = stack.slice(0, -1);
    else if (stage.length > 1) stage = stage.slice(0, -1);
    else break;
    name = build();
  }
  return name.slice(0, MAX_FILTER_SET_ID_LENGTH);
};

export const parseOwnershipId = (
  filterSetId: string | undefined,
): { labels: Record<string, string> } => {
  const parts = (filterSetId ?? "").split(".");
  if (parts.length >= 4 && parts[0] === "alch") {
    return {
      labels: {
        [alchemyLabelKeys.stack]: parts[1] ?? "",
        [alchemyLabelKeys.stage]: parts[2] ?? "",
        [alchemyLabelKeys.id]: parts[3] ?? "",
      },
    };
  }
  return { labels: {} };
};

export const hasOwnershipMarker = (filterSetId: string | undefined) =>
  Object.keys(parseOwnershipId(filterSetId).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (id: string, filterSetId: string | undefined) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const { labels } = parseOwnershipId(filterSetId);
    if (!hasOwnershipMarker(filterSetId)) return false;
    const exact = yield* hasAlchemyLabels(id, labels);
    if (exact) return true;
    return (
      prefixMatch(
        expected[alchemyLabelKeys.stack] ?? "",
        labels[alchemyLabelKeys.stack] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.stage] ?? "",
        labels[alchemyLabelKeys.stage] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.id] ?? "",
        labels[alchemyLabelKeys.id] ?? "",
      )
    );
  });

export const toFilterSetId = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    const labels = yield* createInternalLabels(id);
    if (requested !== undefined && requested.length > 0) {
      if (requested.startsWith("alch.")) {
        return requested.slice(0, MAX_FILTER_SET_ID_LENGTH);
      }
      return encodeOwnershipId(labels, requested);
    }
    if (existing !== undefined && existing.length > 0) return existing;
    const physical = yield* createPhysicalName({
      id,
      maxLength: 40,
      lowercase: true,
    });
    return encodeOwnershipId(labels, physical);
  });

export const resolvedSpec = (spec: FilterSetSpec): FilterSetSpec => {
  const hasRange =
    spec.absoluteDateRange !== undefined ||
    spec.relativeDateRange !== undefined ||
    spec.realtimeTimeRange !== undefined;
  return {
    ...spec,
    relativeDateRange: hasRange
      ? spec.relativeDateRange
      : DEFAULT_RELATIVE_DATE_RANGE,
  };
};

export const specOf = (input: FilterSetSpec): FilterSetSpec => ({
  platforms: input.platforms,
  timeSeriesGranularity: input.timeSeriesGranularity,
  environment: input.environment,
  dealId: input.dealId,
  formats: input.formats,
  creativeId: input.creativeId,
  format: input.format,
  absoluteDateRange: input.absoluteDateRange,
  breakdownDimensions: input.breakdownDimensions,
  relativeDateRange: input.relativeDateRange,
  sellerNetworkIds: input.sellerNetworkIds,
  realtimeTimeRange: input.realtimeTimeRange,
  publisherIdentifiers: input.publisherIdentifiers,
  isTransient: input.isTransient === true,
});

export const specChanged = (previous: FilterSetSpec, next: FilterSetSpec) =>
  !jsonEqual(resolvedSpec(specOf(previous)), resolvedSpec(specOf(next)));

export const toFilterSetBody = (
  name: string,
  spec: FilterSetSpec,
): adex.FilterSet => {
  const resolved = resolvedSpec(spec);
  return {
    name,
    platforms: resolved.platforms,
    timeSeriesGranularity: resolved.timeSeriesGranularity,
    environment: resolved.environment,
    dealId: resolved.dealId,
    formats: resolved.formats,
    creativeId: resolved.creativeId,
    format: resolved.format,
    absoluteDateRange: resolved.absoluteDateRange,
    breakdownDimensions: resolved.breakdownDimensions,
    relativeDateRange: resolved.relativeDateRange,
    sellerNetworkIds: resolved.sellerNetworkIds,
    realtimeTimeRange: resolved.realtimeTimeRange,
    publisherIdentifiers: resolved.publisherIdentifiers,
  };
};

export const toFilterSetAttrs = (
  row: adex.FilterSet,
  ownerName: string,
  project: string,
) => {
  const name = row.name ?? "";
  return {
    name,
    filterSetId: lastSegment(name),
    ownerName: ownerNameOf(name) || ownerName,
    project,
    platforms: row.platforms,
    timeSeriesGranularity: row.timeSeriesGranularity,
    environment: row.environment,
    dealId: row.dealId,
    formats: row.formats,
    creativeId: row.creativeId,
    format: row.format,
    absoluteDateRange: row.absoluteDateRange,
    breakdownDimensions: row.breakdownDimensions,
    relativeDateRange: row.relativeDateRange,
    sellerNetworkIds: row.sellerNetworkIds,
    realtimeTimeRange: row.realtimeTimeRange,
    publisherIdentifiers: row.publisherIdentifiers,
  };
};

const isMissing = <E extends { readonly _tag: string }>(
  error: E,
): error is Extract<E, { readonly _tag: "NotFound" | "Forbidden" }> =>
  error._tag === "NotFound" || error._tag === "Forbidden";

export const ignoreList =
  <A>(fallback: A) =>
  <A1, E extends { readonly _tag: string }, R>(
    self: Effect.Effect<A1, E, R>,
  ): Effect.Effect<A1 | A, E, R> =>
    self.pipe(Effect.catchIf(isMissing, () => Effect.succeed(fallback)));

export const collectFilterSets = <E extends { _tag: string }, R>(
  pages: Stream.Stream<adex.ListFilterSetsResponse, E, R>,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.filterSets ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    ignoreList([] as adex.FilterSet[]),
  );

export const findOwnedFilterSet = (
  rows: readonly adex.FilterSet[],
  id: string,
  name: string,
) =>
  Effect.gen(function* () {
    const exact = rows.find((row) => row.name === name);
    if (exact) return exact;
    for (const row of rows) {
      if (yield* ownedByAlchemy(id, lastSegment(row.name ?? ""))) {
        return row;
      }
    }
    return undefined;
  });

export const ownersFromEnv = (keys: readonly string[], collection: string) => {
  const values: string[] = [];
  for (const key of keys) {
    const raw = process.env[key]?.trim();
    if (!raw) continue;
    for (const part of raw.split(/[,\s]+/)) {
      if (part.length > 0) values.push(expandOwner(part, collection));
    }
  }
  return [...new Set(values)];
};

export const bidderOwnersFromEnv = () =>
  ownersFromEnv(
    ["GCP_ADEXCHANGEBUYER2_BIDDER_ID", "GCP_ADEXCHANGEBUYER2_BIDDER_IDS"],
    "bidders",
  );

export const buyerOwnersFromEnv = () =>
  ownersFromEnv(
    ["GCP_ADEXCHANGEBUYER2_BUYER_ID", "GCP_ADEXCHANGEBUYER2_BUYER_IDS"],
    "buyers",
  );

export const bidderAccountOwnersFromEnv = () => {
  const explicit = ownersFromEnv(
    [
      "GCP_ADEXCHANGEBUYER2_ACCOUNT_OWNER",
      "GCP_ADEXCHANGEBUYER2_ACCOUNT_OWNERS",
    ],
    "bidders",
  ).filter((owner) => owner.includes("/accounts/"));
  const bidder = process.env.GCP_ADEXCHANGEBUYER2_BIDDER_ID?.trim();
  const account = process.env.GCP_ADEXCHANGEBUYER2_ACCOUNT_ID?.trim();
  if (bidder && account) {
    explicit.push(expandBidderAccount(bidder, account));
  }
  return [...new Set(explicit)];
};

export const replaceOnIdentity = (input: {
  previousOwner?: string;
  nextOwner: string;
  previousId?: string;
  nextId?: string;
}) => {
  if (
    input.previousOwner !== undefined &&
    input.previousOwner.length > 0 &&
    input.previousOwner !== input.nextOwner
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousId !== undefined &&
    input.nextId !== undefined &&
    input.previousId !== input.nextId
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  return undefined;
};
