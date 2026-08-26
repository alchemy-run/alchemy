import * as reseller from "@distilled.cloud/gcp/reseller_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const MAX_PURCHASE_ORDER_ID = 80;
export const DEFAULT_PLAN_NAME = "FLEXIBLE";
export const DEFAULT_DELETION_TYPE: reseller.DeleteSubscriptionsDeletionTypeEnum =
  "cancel";
export const DEFAULT_MAXIMUM_SEATS = 1;
export const DEFAULT_NUMBER_OF_SEATS = 1;
export const LIST_PAGE_SIZE = 100;
export const LIST_PAGE_LIMIT = 20;

export class SubscriptionNotResolved extends Data.TaggedError(
  "GCP.Reseller.SubscriptionNotResolved",
)<{
  customerId: string;
  subscriptionId: string;
}> {}

export class CustomerIdRequired extends Data.TaggedError(
  "GCP.Reseller.CustomerIdRequired",
)<{
  id: string;
}> {}

export class SkuIdRequired extends Data.TaggedError(
  "GCP.Reseller.SkuIdRequired",
)<{
  id: string;
}> {}

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const normalizeName = (value: string | undefined) =>
  (value ?? "").trim().replace(/\/+$/, "");

export const lastSegment = (value: string) => {
  const trimmed = normalizeName(value);
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const toCustomerId = (value: string | undefined) => {
  const trimmed = normalizeName(value);
  if (trimmed.length === 0) return undefined;
  if (trimmed.includes("/customers/")) {
    const after = trimmed.split("/customers/")[1] ?? trimmed;
    return after.split("/")[0] || lastSegment(trimmed);
  }
  return lastSegment(trimmed);
};

export const toSubscriptionId = (value: string | undefined) => {
  const trimmed = normalizeName(value);
  if (trimmed.length === 0) return undefined;
  if (trimmed.includes("/subscriptions/")) {
    return lastSegment(trimmed);
  }
  return trimmed;
};

export const resourceName = (customerId: string, subscriptionId: string) =>
  customerId.length > 0 && subscriptionId.length > 0
    ? `customers/${customerId}/subscriptions/${subscriptionId}`
    : "";

export const normalizePlanName = (planName: string | undefined) => {
  const name = (planName ?? "").trim();
  if (name === "ANNUAL_MONTHLY_PAY" || name === "ANNUAL") return "ANNUAL";
  return name;
};

export const isAnnualPlan = (planName: string | undefined) => {
  const name = normalizePlanName(planName);
  return name === "ANNUAL" || name === "ANNUAL_YEARLY_PAY";
};

export const isFreePlan = (planName: string | undefined) =>
  normalizePlanName(planName) === "FREE";

export const planNamesEqual = (
  left: string | undefined,
  right: string | undefined,
) => normalizePlanName(left) === normalizePlanName(right);

export const seatsForPlan = (
  planName: string | undefined,
  seats: reseller.Seats | undefined,
): reseller.Seats | undefined => {
  if (isFreePlan(planName)) {
    return seats === undefined
      ? undefined
      : {
          numberOfSeats: seats.numberOfSeats,
          maximumNumberOfSeats: seats.maximumNumberOfSeats,
        };
  }
  if (isAnnualPlan(planName)) {
    return {
      numberOfSeats: seats?.numberOfSeats ?? DEFAULT_NUMBER_OF_SEATS,
    };
  }
  return {
    maximumNumberOfSeats: seats?.maximumNumberOfSeats ?? DEFAULT_MAXIMUM_SEATS,
  };
};

export const seatsEqual = (
  left: reseller.Seats | undefined,
  right: reseller.Seats | undefined,
) =>
  (left?.numberOfSeats ?? undefined) === (right?.numberOfSeats ?? undefined) &&
  (left?.maximumNumberOfSeats ?? undefined) ===
    (right?.maximumNumberOfSeats ?? undefined);

const markerOf = (stack: string, stage: string, id: string) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

export const fitMarker = (
  labels: Record<string, string>,
  maxLength: number,
) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerOf(stack, stage, id);
  while (
    marker.length > maxLength &&
    (stack.length > 1 || stage.length > 1 || id.length > 1)
  ) {
    if (id.length >= stack.length && id.length >= stage.length) {
      id = id.slice(0, -1);
    } else if (stack.length >= stage.length) {
      stack = stack.slice(0, -1);
    } else {
      stage = stage.slice(0, -1);
    }
    marker = markerOf(stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

export const encodePurchaseOrderId = (
  labels: Record<string, string>,
  purchaseOrderId: string | undefined,
  maxLength = MAX_PURCHASE_ORDER_ID,
): string => {
  const trimmed = purchaseOrderId?.replace(/[\r\n]+/g, " ").trim();
  if (!trimmed) return fitMarker(labels, maxLength);
  const minMarker = 24;
  const reserved = Math.min(
    trimmed.length + 1,
    Math.max(0, maxLength - minMarker),
  );
  const marker = fitMarker(labels, maxLength - reserved);
  return `${marker} ${trimmed}`.slice(0, maxLength);
};

export const parsePurchaseOrderId = (
  purchaseOrderId: string | undefined,
): {
  labels: Record<string, string>;
  purchaseOrderId: string | undefined;
} => {
  if (!purchaseOrderId?.startsWith("[alchemy ")) {
    return { labels: {}, purchaseOrderId };
  }
  const end = purchaseOrderId.indexOf("]");
  if (end < 0) return { labels: {}, purchaseOrderId };
  const labels: Record<string, string> = {};
  for (const part of purchaseOrderId
    .slice("[alchemy ".length, end)
    .split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = purchaseOrderId.slice(end + 1).replace(/^[\s\n]+/, "");
  return {
    labels,
    purchaseOrderId: rest.length > 0 ? rest : undefined,
  };
};

export const hasOwnershipMarker = (purchaseOrderId: string | undefined) =>
  Object.keys(parsePurchaseOrderId(purchaseOrderId).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (
  id: string,
  purchaseOrderId: string | undefined,
) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const { labels } = parsePurchaseOrderId(purchaseOrderId);
    if (!hasOwnershipMarker(purchaseOrderId)) return false;
    if (yield* hasAlchemyLabels(id, labels)) return true;
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

export const ownershipLabels = (id: string) => createInternalLabels(id);

export const sameCustomer = (
  left: string | undefined,
  right: string | undefined,
  domain?: string,
) => {
  const a = toCustomerId(left);
  const b = toCustomerId(right);
  if (a === undefined || b === undefined) return false;
  if (a === b) return true;
  const d = toCustomerId(domain);
  return d !== undefined && (a === d || b === d);
};

export const replaceOnIdentity = (input: {
  previousCustomerId?: string;
  nextCustomerId?: string;
  customerDomain?: string;
  previousSkuId?: string;
  nextSkuId?: string;
}) => {
  if (
    input.previousSkuId !== undefined &&
    input.nextSkuId !== undefined &&
    input.previousSkuId !== input.nextSkuId
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousCustomerId !== undefined &&
    input.nextCustomerId !== undefined &&
    !sameCustomer(
      input.previousCustomerId,
      input.nextCustomerId,
      input.customerDomain,
    )
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  return undefined;
};

const emptyList = () => Effect.succeed([] as reseller.Subscription[]);

const isMissing = <E extends { readonly _tag: string }>(
  error: E,
): error is Extract<E, { readonly _tag: "NotFound" | "Forbidden" }> =>
  error._tag === "NotFound" || error._tag === "Forbidden";

export const ignoreMissing = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | void, E, R> =>
  effect.pipe(Effect.catchIf(isMissing, () => Effect.void));

export const retryConflict = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 8,
      schedule: Schedule.exponential("500 millis"),
    }),
  );

export const getSubscription = (
  customerId: string | undefined,
  subscriptionId: string | undefined,
) => {
  const customer = toCustomerId(customerId) ?? "";
  const subscription = toSubscriptionId(subscriptionId) ?? "";
  if (customer.length === 0 || subscription.length === 0) {
    return Effect.succeed(undefined);
  }
  return reseller
    .getSubscriptions({
      customerId: customer,
      subscriptionId: subscription,
    })
    .pipe(
      Effect.catchTag(["NotFound", "Forbidden"], () =>
        Effect.succeed(undefined),
      ),
    );
};

export const listSubscriptions = (customerId?: string) => {
  const customer = toCustomerId(customerId);
  return reseller.listSubscriptions
    .pages({
      customerId: customer,
      maxResults: LIST_PAGE_SIZE,
    })
    .pipe(
      Stream.take(LIST_PAGE_LIMIT),
      Stream.flatMap((page) => Stream.fromIterable(page.subscriptions ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag(["NotFound", "Forbidden"], () => emptyList()),
    );
};

export const listOwnedSubscriptions = () =>
  listSubscriptions().pipe(
    Effect.map((rows) =>
      rows.filter((row) => hasOwnershipMarker(row.purchaseOrderId)),
    ),
  );

export const findOwnedSubscription = (id: string, customerId?: string) =>
  Effect.gen(function* () {
    const rows = yield* listSubscriptions(customerId);
    for (const row of rows) {
      if (yield* ownedByAlchemy(id, row.purchaseOrderId)) {
        return row;
      }
    }
    return undefined;
  });

export const findOwnedBySku = (id: string, customerId: string, skuId: string) =>
  Effect.gen(function* () {
    if (customerId.length === 0 || skuId.length === 0) return undefined;
    const rows = yield* listSubscriptions(customerId);
    for (const row of rows) {
      if (
        sameText(row.skuId, skuId) &&
        (yield* ownedByAlchemy(id, row.purchaseOrderId))
      ) {
        return row;
      }
    }
    return undefined;
  });

export const findBySku = (customerId: string, skuId: string) =>
  Effect.gen(function* () {
    if (customerId.length === 0 || skuId.length === 0) return undefined;
    const rows = yield* listSubscriptions(customerId);
    return rows.find((row) => sameText(row.skuId, skuId));
  });

export const toAttrs = (
  row: reseller.Subscription,
  project: string,
  deletionType: string | undefined,
) => {
  const customerId = toCustomerId(row.customerId) ?? "";
  const subscriptionId = toSubscriptionId(row.subscriptionId) ?? "";
  return {
    name: resourceName(customerId, subscriptionId),
    customerId,
    subscriptionId,
    project,
    skuId: row.skuId,
    skuName: row.skuName,
    planName: row.plan?.planName,
    isCommitmentPlan: row.plan?.isCommitmentPlan,
    commitmentInterval: row.plan?.commitmentInterval,
    seats: row.seats
      ? {
          numberOfSeats: row.seats.numberOfSeats,
          maximumNumberOfSeats: row.seats.maximumNumberOfSeats,
          licensedNumberOfSeats: row.seats.licensedNumberOfSeats,
        }
      : undefined,
    purchaseOrderId: parsePurchaseOrderId(row.purchaseOrderId).purchaseOrderId,
    renewalType: row.renewalSettings?.renewalType,
    dealCode: row.dealCode,
    status: row.status,
    suspended: row.status === "SUSPENDED",
    billingMethod: row.billingMethod,
    customerDomain: row.customerDomain,
    creationTime: row.creationTime,
    trialEndTime: row.trialSettings?.trialEndTime,
    isInTrial: row.trialSettings?.isInTrial,
    suspensionReasons: row.suspensionReasons,
    resourceUiUrl: row.resourceUiUrl,
    kind: row.kind,
    deletionType: deletionType ?? DEFAULT_DELETION_TYPE,
  };
};
