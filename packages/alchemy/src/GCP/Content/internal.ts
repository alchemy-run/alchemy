import * as content from "@distilled.cloud/gcp/content_v2_1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const MAX_DISPLAY_NAME_LENGTH = 240;
export const MAX_CONVERSION_DISPLAY_NAME_LENGTH = 64;
export const MAX_ID_LENGTH = 50;
export const MAX_STORE_NAME_LENGTH = 250;
export const MAX_PRODUCT_TITLE_LENGTH = 150;
export const MAX_PRODUCT_DESCRIPTION_LENGTH = 5000;
export const DEFAULT_LOOKBACK_DAYS = 30;
export const DEFAULT_ATTRIBUTION_MODEL = "CROSS_CHANNEL_LAST_CLICK";
export const DEFAULT_CURRENCY = "USD";
export const DEFAULT_CONTENT_TYPE = "products";
export const DEFAULT_CHANNEL = "online";
export const DEFAULT_LANGUAGE = "en";
export const DEFAULT_COUNTRY = "US";
export const DEFAULT_AVAILABILITY = "in stock";
export const DEFAULT_CONDITION = "new";
export const DEFAULT_PRICE = { currency: "USD", value: "1.00" } as const;
export const ALCHEMY_URI_PARAM = "alc";

export const merchantIdFromEnv = () =>
  process.env.GCP_CONTENT_MERCHANT_ID?.trim() || undefined;

export const targetMerchantIdFromEnv = () =>
  process.env.GCP_CONTENT_TARGET_MERCHANT_ID?.trim() || merchantIdFromEnv();

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  JSON.stringify([...(left ?? [])].slice().sort()) ===
  JSON.stringify([...(right ?? [])].slice().sort());

export const productRestId = (input: {
  channel: string;
  contentLanguage: string;
  targetCountry?: string;
  feedLabel?: string;
  offerId: string;
}) =>
  `${input.channel}:${input.contentLanguage}:${input.feedLabel ?? input.targetCountry}:${input.offerId}`;

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

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

export const collectPages = <Page, A, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly A[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

const markerOf = (
  _labels: Record<string, string>,
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

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_PRODUCT_DESCRIPTION_LENGTH,
): string => {
  const marker = fitMarker(labels, Math.min(800, maxLength));
  const trimmed = text?.trim();
  const combined =
    trimmed && trimmed.length > 0 ? `${marker}\n${trimmed}` : marker;
  return combined.slice(0, maxLength);
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

export const toResourceId = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = MAX_ID_LENGTH,
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
      : `c${generated}`.slice(0, maxLength);
  });

export const toDisplayName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = 40,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return requested.slice(0, maxLength);
    }
    if (existing !== undefined && existing.length > 0) {
      return existing.slice(0, maxLength);
    }
    const generated = yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
    });
    return /^[a-z]/.test(generated)
      ? generated
      : `c${generated}`.slice(0, maxLength);
  });

export const compactToken = (labels: Record<string, string>) => {
  const stack = labels[alchemyLabelKeys.stack] ?? "x";
  const stage = labels[alchemyLabelKeys.stage] ?? "x";
  const id = labels[alchemyLabelKeys.id] ?? "x";
  return `${stack}.${stage}.${id}`.slice(0, 80);
};

export const stampCheckoutUri = (
  labels: Record<string, string>,
  uri: string | undefined,
) => {
  const token = compactToken(labels);
  const base = uri?.trim() || "https://example.com/checkout?item_id={id}";
  if (base.includes(`${ALCHEMY_URI_PARAM}=`)) {
    return base.replace(
      new RegExp(`${ALCHEMY_URI_PARAM}=[^&]*`),
      `${ALCHEMY_URI_PARAM}=${token}`,
    );
  }
  return base.includes("?")
    ? `${base}&${ALCHEMY_URI_PARAM}=${token}`
    : `${base}?${ALCHEMY_URI_PARAM}=${token}`;
};

export const checkoutOwnershipToken = (uri: string | undefined) => {
  if (!uri) return undefined;
  const match = uri.match(new RegExp(`[?&]${ALCHEMY_URI_PARAM}=([^&]+)`));
  return match?.[1];
};

export const hasCheckoutOwnership = (uri: string | undefined) =>
  (checkoutOwnershipToken(uri) ?? "").length > 0;

export const stripCheckoutOwnership = (uri: string | undefined) => {
  if (!uri) return undefined;
  const stripped = uri
    .replace(new RegExp(`[?&]${ALCHEMY_URI_PARAM}=[^&]*`), "")
    .replace(/\?&/, "?")
    .replace(/[?&]$/, "");
  return stripped.length > 0 ? stripped : undefined;
};

export const listAccessibleMerchantIds = Effect.fn(function* () {
  const ids = new Set<string>();
  const fromEnv = merchantIdFromEnv();
  if (fromEnv) ids.add(fromEnv);
  const info = yield* content
    .authinfoAccounts({})
    .pipe(
      ignoreList(undefined as content.AccountsAuthInfoResponse | undefined),
    );
  for (const account of info?.accountIdentifiers ?? []) {
    if (account.merchantId) ids.add(account.merchantId);
  }
  return [...ids];
});

export const listAccessibleAggregatorIds = Effect.fn(function* () {
  const ids = new Set<string>();
  const fromEnv = merchantIdFromEnv();
  if (fromEnv) ids.add(fromEnv);
  const info = yield* content
    .authinfoAccounts({})
    .pipe(
      ignoreList(undefined as content.AccountsAuthInfoResponse | undefined),
    );
  for (const account of info?.accountIdentifiers ?? []) {
    if (account.aggregatorId) ids.add(account.aggregatorId);
  }
  return [...ids];
});

export const listCollectionsAt = (merchantId: string) =>
  merchantId.length === 0
    ? Effect.succeed([] as content.Collection[])
    : collectPages(
        content.listCollections.pages({ merchantId, pageSize: 200 }),
        (page) => page.resources,
      ).pipe(ignoreList([] as content.Collection[]));

export const listConversionSourcesAt = (merchantId: string) =>
  merchantId.length === 0
    ? Effect.succeed([] as content.ConversionSource[])
    : collectPages(
        content.listConversionsources.pages({
          merchantId,
          pageSize: 200,
          showDeleted: true,
        }),
        (page) => page.conversionSources,
      ).pipe(ignoreList([] as content.ConversionSource[]));

export const listRegionsAt = (merchantId: string) =>
  merchantId.length === 0
    ? Effect.succeed([] as content.Region[])
    : collectPages(
        content.listRegions.pages({ merchantId, pageSize: 200 }),
        (page) => page.regions,
      ).pipe(ignoreList([] as content.Region[]));

export const listReturnPoliciesAt = (merchantId: string) =>
  merchantId.length === 0
    ? Effect.succeed([] as content.ReturnPolicyOnline[])
    : content.listReturnpolicyonline({ merchantId }).pipe(
        Effect.map((page) => page.returnPolicies ?? []),
        ignoreList([] as content.ReturnPolicyOnline[]),
      );

export const listAccountsAt = (merchantId: string) =>
  merchantId.length === 0
    ? Effect.succeed([] as content.Account[])
    : collectPages(
        content.listAccounts.pages({ merchantId, maxResults: 250 }),
        (page) => page.resources,
      ).pipe(ignoreList([] as content.Account[]));

export const listDatafeedsAt = (merchantId: string) =>
  merchantId.length === 0
    ? Effect.succeed([] as content.Datafeed[])
    : collectPages(
        content.listDatafeeds.pages({ merchantId, maxResults: 250 }),
        (page) => page.resources,
      ).pipe(ignoreList([] as content.Datafeed[]));

export const listProductsAt = (merchantId: string) =>
  merchantId.length === 0
    ? Effect.succeed([] as content.Product[])
    : collectPages(
        content.listProducts.pages({ merchantId, maxResults: 250 }),
        (page) => page.resources,
      ).pipe(ignoreList([] as content.Product[]));

export const getCollection = (merchantId: string, collectionId: string) =>
  merchantId.length === 0 || collectionId.length === 0
    ? Effect.succeed(undefined)
    : content
        .getCollections({ merchantId, collectionId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const getConversionSource = (
  merchantId: string,
  conversionSourceId: string,
) =>
  merchantId.length === 0 || conversionSourceId.length === 0
    ? Effect.succeed(undefined)
    : content
        .getConversionsources({ merchantId, conversionSourceId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const getProductDeliveryTime = (
  merchantId: string,
  productId: string,
) =>
  merchantId.length === 0 || productId.length === 0
    ? Effect.succeed(undefined)
    : content
        .getProductdeliverytime({ merchantId, productId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const getRegion = (merchantId: string, regionId: string) =>
  merchantId.length === 0 || regionId.length === 0
    ? Effect.succeed(undefined)
    : content
        .getRegions({ merchantId, regionId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const getReturnPolicy = (merchantId: string, returnPolicyId: string) =>
  merchantId.length === 0 || returnPolicyId.length === 0
    ? Effect.succeed(undefined)
    : content
        .getReturnpolicyonline({ merchantId, returnPolicyId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const getAccount = (merchantId: string, accountId: string) =>
  merchantId.length === 0 || accountId.length === 0
    ? Effect.succeed(undefined)
    : content
        .getAccounts({ merchantId, accountId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const getDatafeed = (merchantId: string, datafeedId: string) =>
  merchantId.length === 0 || datafeedId.length === 0
    ? Effect.succeed(undefined)
    : content
        .getDatafeeds({ merchantId, datafeedId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const getCheckoutSettings = (merchantId: string) =>
  merchantId.length === 0
    ? Effect.succeed(undefined)
    : content
        .getFreelistingsprogramCheckoutsettings({ merchantId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const getProduct = (merchantId: string, productId: string) =>
  merchantId.length === 0 || productId.length === 0
    ? Effect.succeed(undefined)
    : content.getProducts({ merchantId, productId }).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
      );

export const getPosStore = (
  merchantId: string,
  targetMerchantId: string,
  storeCode: string,
) =>
  merchantId.length === 0 ||
  targetMerchantId.length === 0 ||
  storeCode.length === 0
    ? Effect.succeed(undefined)
    : content.getPos({ merchantId, targetMerchantId, storeCode }).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
      );

export const listPosAt = (merchantId: string, targetMerchantId: string) =>
  merchantId.length === 0 || targetMerchantId.length === 0
    ? Effect.succeed([] as content.PosStore[])
    : content.listPos({ merchantId, targetMerchantId }).pipe(
        Effect.map((page) => page.resources ?? []),
        ignoreList([] as content.PosStore[]),
      );

export const findOwnedProduct = (
  id: string,
  merchantId: string,
  offerId?: string,
) =>
  Effect.gen(function* () {
    const products = yield* listProductsAt(merchantId);
    for (const product of products) {
      if (offerId && product.offerId !== offerId) continue;
      if (yield* ownedByAlchemy(id, product.description)) return product;
    }
    return undefined;
  });

export const findOwnedPos = (
  id: string,
  merchantId: string,
  targetMerchantId: string,
  storeCode?: string,
) =>
  Effect.gen(function* () {
    const stores = yield* listPosAt(merchantId, targetMerchantId);
    for (const store of stores) {
      if (storeCode && store.storeCode !== storeCode) continue;
      if (yield* ownedByAlchemy(id, store.storeName)) return store;
    }
    return undefined;
  });

export const listOwnedProducts = () =>
  Effect.gen(function* () {
    const merchantIds = yield* listAccessibleMerchantIds();
    const pages = yield* Effect.forEach(
      merchantIds,
      (merchantId) =>
        listProductsAt(merchantId).pipe(
          Effect.map((products) =>
            products
              .filter((product) => hasOwnershipMarker(product.description))
              .map((product) => ({ merchantId, product })),
          ),
        ),
      { concurrency: 4 },
    );
    return pages.flat();
  });

export const listOwnedPos = () =>
  Effect.gen(function* () {
    const merchantIds = yield* listAccessibleMerchantIds();
    const target = targetMerchantIdFromEnv();
    const pages = yield* Effect.forEach(
      merchantIds,
      (merchantId) =>
        listPosAt(merchantId, target ?? merchantId).pipe(
          Effect.map((stores) =>
            stores
              .filter((store) => hasOwnershipMarker(store.storeName))
              .map((store) => ({
                merchantId,
                targetMerchantId: target ?? merchantId,
                store,
              })),
          ),
        ),
      { concurrency: 4 },
    );
    return pages.flat();
  });
