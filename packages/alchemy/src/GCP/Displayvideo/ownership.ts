import * as dv from "@distilled.cloud/gcp/displayvideo_v4";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const MAX_DISPLAY_NAME_LENGTH = 240;
export const MAX_AD_GROUP_DISPLAY_NAME_LENGTH = 255;
export const DEFAULT_FLIGHT: DateRangeValue = {
  startDate: { year: 2030, month: 1, day: 15 },
  endDate: { year: 2030, month: 12, day: 15 },
};

export type DateValue = {
  year?: number;
  month?: number;
  day?: number;
};

export type DateRangeValue = {
  startDate?: DateValue;
  endDate?: DateValue;
};

export type FrequencyCapValue = {
  unlimited?: boolean;
  maxImpressions?: number;
  maxViews?: number;
  timeUnit?: string;
  timeUnitCount?: number;
};

export type PacingValue = {
  pacingPeriod?: string;
  pacingType?: string;
  dailyMaxMicros?: string;
  dailyMaxImpressions?: string;
};

export type IntegrationDetailsValue = {
  integrationCode?: string;
  details?: string;
};

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const toDisplayName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = 40,
) =>
  Effect.gen(function* () {
    if (requested !== undefined) return requested;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
    });
    return /^[a-z]/.test(generated)
      ? generated
      : `d${generated}`.slice(0, maxLength);
  });

const markerOf = (
  labels: Record<string, string>,
  stack: string,
  stage: string,
  id: string,
) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const fitMarker = (labels: Record<string, string>, maxLength: number) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerOf(labels, stack, stage, id);
  while (
    marker.length > maxLength &&
    (stack.length > 1 || stage.length > 1 || id.length > 1)
  ) {
    if (stack.length >= stage.length && stack.length >= id.length) {
      stack = stack.slice(0, -1);
    } else if (stage.length >= id.length) {
      stage = stage.slice(0, -1);
    } else {
      id = id.slice(0, -1);
    }
    marker = markerOf(labels, stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

export const encodeOwnershipLine = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_DISPLAY_NAME_LENGTH,
): string => {
  const trimmed = text?.replace(/[\r\n]+/g, " ").trim();
  if (!trimmed) return fitMarker(labels, maxLength);
  const minMarker = 24;
  const reserved = Math.min(
    trimmed.length + 1,
    Math.max(0, maxLength - minMarker),
  );
  const marker = fitMarker(labels, maxLength - reserved);
  return `${marker} ${trimmed}`.slice(0, maxLength);
};

export const parseOwnership = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (!text?.startsWith("[alchemy ")) {
    return { labels: {}, text };
  }
  const end = text.indexOf("]");
  if (end < 0) return { labels: {}, text };
  const labels: Record<string, string> = {};
  for (const part of text.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = text.slice(end + 1).replace(/^[\s\n]+/, "");
  return { labels, text: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (text: string | undefined) =>
  Object.keys(parseOwnership(text).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (id: string, text: string | undefined) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const { labels } = parseOwnership(text);
    if (!hasOwnershipMarker(text)) return false;
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

export const partnerIdFromEnv = () =>
  process.env.GCP_DISPLAYVIDEO_PARTNER_ID?.trim() || undefined;

export const advertiserIdFromEnv = () =>
  process.env.GCP_DISPLAYVIDEO_ADVERTISER_ID?.trim() || undefined;

export const ignoreList =
  <A>(fallback: A) =>
  <A1, E extends { readonly _tag: string }, R>(
    self: Effect.Effect<A1, E, R>,
  ): Effect.Effect<A1 | A, E, R> =>
    self.pipe(
      Effect.catchIf(
        (
          error,
        ): error is Extract<E, { readonly _tag: "NotFound" | "Forbidden" }> =>
          error._tag === "NotFound" || error._tag === "Forbidden",
        () => Effect.succeed(fallback),
      ),
    );

export const listAdvertisers = (partnerId: string) =>
  dv.listAdvertisers.pages({ partnerId, pageSize: 200 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.advertisers ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    ignoreList([] as dv.Advertiser[]),
  );

export const listOwnedAdvertiserIds = Effect.fn(function* () {
  const fromEnv = advertiserIdFromEnv();
  if (fromEnv) return [fromEnv];
  const partnerId = partnerIdFromEnv();
  if (!partnerId) return [] as string[];
  const advertisers = yield* listAdvertisers(partnerId);
  return advertisers
    .filter(
      (advertiser) =>
        hasOwnershipMarker(advertiser.displayName) ||
        hasOwnershipMarker(advertiser.integrationDetails?.integrationCode),
    )
    .map((advertiser) => advertiser.advertiserId)
    .filter((id): id is string => !!id);
});

export const findAdvertiserByDisplayName = (
  partnerId: string,
  displayName: string,
) =>
  listAdvertisers(partnerId).pipe(
    Effect.map((advertisers) =>
      advertisers.find((advertiser) => advertiser.displayName === displayName),
    ),
  );

export const defaultUnlimitedCap = (): FrequencyCapValue => ({
  unlimited: true,
});

export const defaultDailyPacing = (
  dailyMaxMicros = "1000000",
): PacingValue => ({
  pacingPeriod: "PACING_PERIOD_DAILY",
  pacingType: "PACING_TYPE_EVEN",
  dailyMaxMicros,
});

export const MAX_KEYWORD_LENGTH = 80;

export const lineItemIdFromEnv = () =>
  process.env.GCP_DISPLAYVIDEO_LINE_ITEM_ID?.trim() || undefined;

export const channelIdFromEnv = () =>
  process.env.GCP_DISPLAYVIDEO_CHANNEL_ID?.trim() || undefined;

export const listPartners = () =>
  dv.listPartners.pages({ pageSize: 200 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.partners ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    ignoreList([] as dv.Partner[]),
  );

export const listAccessiblePartnerIds = Effect.fn(function* () {
  const fromEnv = partnerIdFromEnv();
  if (fromEnv) return [fromEnv];
  const partners = yield* listPartners();
  return partners
    .map((partner) => partner.partnerId)
    .filter((id): id is string => !!id);
});

export const listAccessibleAdvertiserIds = Effect.fn(function* () {
  const ids = new Set<string>();
  const fromEnv = advertiserIdFromEnv();
  if (fromEnv) ids.add(fromEnv);
  const partnerIds = yield* listAccessiblePartnerIds();
  const pages = yield* Effect.forEach(
    partnerIds,
    (partnerId) => listAdvertisers(partnerId),
    { concurrency: 4 },
  );
  for (const advertisers of pages) {
    for (const advertiser of advertisers) {
      if (advertiser.advertiserId) ids.add(advertiser.advertiserId);
    }
  }
  return [...ids];
});

export const listLineItems = (advertiserId: string) =>
  dv.listAdvertisersLineItems.pages({ advertiserId, pageSize: 200 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.lineItems ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    ignoreList([] as dv.LineItem[]),
  );

export const parsePathId = (name: string, collection: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const index = parts.indexOf(collection);
  return index >= 0 ? (parts[index + 1] ?? "") : "";
};
