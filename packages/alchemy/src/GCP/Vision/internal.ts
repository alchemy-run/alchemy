import * as vision from "@distilled.cloud/gcp/vision_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const DEFAULT_LOCATION = "us-west1";
export const DEFAULT_PRODUCT_CATEGORY = "homegoods-v2";
export const MAX_ID_LENGTH = 128;
export const MAX_DISPLAY_NAME_LENGTH = 4096;
export const MAX_DESCRIPTION_LENGTH = 4096;

/** Cloud Vision Product Search regional endpoints. */
export const PRODUCT_SEARCH_LOCATIONS = [
  "us-west1",
  "us-east1",
  "europe-west1",
  "asia-east1",
] as const;

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

export const ownershipLabels = (id: string) => createInternalLabels(id);

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const parentOf = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  return parts.slice(0, -2).join("/");
};

export const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

export const locationParent = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

export const productSetNameOf = (
  project: string,
  location: string,
  productSetId: string,
) => {
  if (productSetId.length === 0) return "";
  if (productSetId.includes("/productSets/")) {
    return productSetId.replace(/\/+$/, "");
  }
  return `${locationParent(project, location)}/productSets/${lastSegment(productSetId)}`;
};

export const productNameOf = (
  project: string,
  location: string,
  productId: string,
) => {
  if (productId.length === 0) return "";
  if (productId.includes("/products/")) {
    return productId.replace(/\/+$/, "");
  }
  return `${locationParent(project, location)}/products/${lastSegment(productId)}`;
};

export const referenceImageNameOf = (parent: string, imageId: string) => {
  if (imageId.length === 0) return "";
  if (imageId.includes("/referenceImages/")) {
    return imageId.replace(/\/+$/, "");
  }
  return `${parent}/referenceImages/${lastSegment(imageId)}`;
};

export const expandProductName = (
  project: string,
  location: string,
  value: string,
) => productNameOf(project, location, value);

export const parseResourceName = (
  name: string,
  fallbackProject: string,
  collection: string,
) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    name,
    project:
      projectsAt >= 0 && parts[projectsAt + 1]
        ? parts[projectsAt + 1]!
        : fallbackProject,
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : DEFAULT_LOCATION,
    id:
      collectionAt >= 0 && parts[collectionAt + 1]
        ? parts[collectionAt + 1]!
        : lastSegment(name),
    parent:
      collectionAt >= 0
        ? parts.slice(0, collectionAt).join("/")
        : parentOf(name),
  };
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const replaceOnIdentity = (input: {
  previousId?: string;
  nextId?: string;
  previousParent?: string;
  nextParent?: string;
  extra?: boolean;
}) => {
  if (input.extra === true) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousId !== undefined &&
    input.nextId !== undefined &&
    input.previousId !== input.nextId
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousParent !== undefined &&
    input.nextParent !== undefined &&
    input.previousParent !== input.nextParent
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  return undefined;
};

export const toResourceId = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = MAX_ID_LENGTH,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return lastSegment(requested).slice(0, maxLength);
    }
    if (existing !== undefined && existing.length > 0) {
      return lastSegment(existing).slice(0, maxLength);
    }
    const generated = yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
    });
    const next = /^[a-z]/.test(generated)
      ? generated
      : `v${generated}`.slice(0, maxLength);
    return next.length >= 4 ? next : `${next}xxxx`.slice(0, maxLength);
  });

const emptyList = <A>() => Effect.succeed([] as A[]);

export const catchMissing = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" | "Forbidden" } =>
        error._tag === "NotFound" || error._tag === "Forbidden",
      () => Effect.succeed(undefined),
    ),
  );

export const ignoreMissing = <E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<unknown, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" | "Forbidden" } =>
        error._tag === "NotFound" || error._tag === "Forbidden",
      () => Effect.void,
    ),
  );

export const waitUntilGone = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
) =>
  get.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (value) => value === undefined,
      times: 10,
    }),
    Effect.asVoid,
  );

const collectPages = <Page, Item, E extends { readonly _tag: string }, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly Item[] | null | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk) as Item[]),
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" | "Forbidden" } =>
        error._tag === "NotFound" || error._tag === "Forbidden",
      () => emptyList<Item>(),
    ),
  );

export const getProductSet = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(vision.getProjectsLocationsProductSets({ name }));

export const getProduct = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(vision.getProjectsLocationsProducts({ name }));

export const getReferenceImage = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        vision.getProjectsLocationsProductsReferenceImages({ name }),
      );

export const listProductSets = (parent: string) =>
  parent.length === 0
    ? emptyList<vision.ProductSet>()
    : collectPages(
        vision.listProjectsLocationsProductSets.pages({
          parent,
          pageSize: 100,
        }),
        (page) => page.productSets,
      );

export const listProducts = (parent: string) =>
  parent.length === 0
    ? emptyList<vision.Product>()
    : collectPages(
        vision.listProjectsLocationsProducts.pages({
          parent,
          pageSize: 100,
        }),
        (page) => page.products,
      );

export const listProductsInSet = (name: string) =>
  name.length === 0
    ? emptyList<vision.Product>()
    : collectPages(
        vision.listProjectsLocationsProductSetsProducts.pages({
          name,
          pageSize: 100,
        }),
        (page) => page.products,
      );

export const listReferenceImages = (parent: string) =>
  parent.length === 0
    ? emptyList<vision.ReferenceImage>()
    : collectPages(
        vision.listProjectsLocationsProductsReferenceImages.pages({
          parent,
          pageSize: 100,
        }),
        (page) => page.referenceImages,
      );

const listAcrossLocations = <A, E, R>(
  project: string,
  listAt: (parent: string) => Effect.Effect<A[], E, R>,
) =>
  Effect.gen(function* () {
    const pages = yield* Effect.forEach(
      PRODUCT_SEARCH_LOCATIONS,
      (location) => listAt(locationParent(project, location)),
      { concurrency: 4 },
    );
    return pages.flat();
  });

export const listOwnedProductSets = (project: string) =>
  listAcrossLocations(project, listProductSets).pipe(
    Effect.map((sets) =>
      sets.filter((set) => hasOwnershipMarker(set.displayName)),
    ),
  );

export const productLabelsRecord = (
  labels: vision.KeyValueList | undefined,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const item of labels ?? []) {
    if (item.key) out[item.key] = item.value ?? "";
  }
  return out;
};

export const stripAlchemyProductLabels = (
  labels: vision.KeyValueList | undefined,
): Array<{ key: string; value: string }> =>
  (labels ?? [])
    .filter(
      (item): item is { key: string; value?: string } =>
        typeof item.key === "string" &&
        item.key.length > 0 &&
        !item.key.startsWith("alchemy-"),
    )
    .map((item) => ({ key: item.key, value: item.value ?? "" }));

export const withAlchemyProductLabels = (
  user: ReadonlyArray<{ key: string; value: string }> | undefined,
  ownership: Record<string, string>,
): vision.KeyValueList => [
  ...stripAlchemyProductLabels(user as vision.KeyValueList | undefined),
  ...Object.entries(ownership).map(([key, value]) => ({ key, value })),
];

export const sameProductLabels = (
  left: ReadonlyArray<{ key: string; value: string }> | undefined,
  right: ReadonlyArray<{ key: string; value: string }> | undefined,
) =>
  jsonEqual(
    [...(left ?? [])].map((item) => `${item.key}=${item.value}`).sort(),
    [...(right ?? [])].map((item) => `${item.key}=${item.value}`).sort(),
  );

export const productOwnedByAlchemy = (id: string, product: vision.Product) =>
  Effect.gen(function* () {
    if (yield* ownedByAlchemy(id, product.displayName)) return true;
    if (yield* ownedByAlchemy(id, product.description)) return true;
    return yield* hasAlchemyLabels(
      id,
      productLabelsRecord(product.productLabels),
    );
  });

export const productHasOwnershipMarker = (product: vision.Product) =>
  hasOwnershipMarker(product.displayName) ||
  hasOwnershipMarker(product.description) ||
  Object.keys(productLabelsRecord(product.productLabels)).some((key) =>
    key.startsWith("alchemy-"),
  );

export const listOwnedProducts = (project: string) =>
  listAcrossLocations(project, listProducts).pipe(
    Effect.map((products) => products.filter(productHasOwnershipMarker)),
  );

export const listOwnedReferenceImages = (project: string) =>
  Effect.gen(function* () {
    const products = yield* listOwnedProducts(project);
    const pages = yield* Effect.forEach(
      products,
      (product) =>
        product.name
          ? listReferenceImages(product.name)
          : emptyList<vision.ReferenceImage>(),
      { concurrency: 4 },
    );
    return pages.flat();
  });

export const findOwnedProductSet = (
  project: string,
  location: string,
  id: string,
) =>
  Effect.gen(function* () {
    const sets = yield* listProductSets(locationParent(project, location));
    for (const set of sets) {
      if (yield* ownedByAlchemy(id, set.displayName)) {
        return set;
      }
    }
    return undefined;
  });

export const findOwnedProduct = (
  project: string,
  location: string,
  id: string,
) =>
  Effect.gen(function* () {
    const products = yield* listProducts(locationParent(project, location));
    for (const product of products) {
      if (yield* productOwnedByAlchemy(id, product)) {
        return product;
      }
    }
    return undefined;
  });

export const findOwnedReferenceImage = (
  parent: string,
  imageId: string,
  outputName: string | undefined,
) =>
  Effect.gen(function* () {
    const name = outputName ?? referenceImageNameOf(parent, imageId);
    const existing = yield* getReferenceImage(name);
    if (existing !== undefined) return existing;
    if (parent.length === 0) return undefined;
    const images = yield* listReferenceImages(parent);
    if (imageId.length === 0) return undefined;
    return images.find(
      (image) => lastSegment(image.name ?? "") === lastSegment(imageId),
    );
  });

export const deleteProductSet = (name: string) =>
  name.length === 0
    ? Effect.void
    : ignoreMissing(vision.deleteProjectsLocationsProductSets({ name }));

export const deleteProduct = (name: string) =>
  name.length === 0
    ? Effect.void
    : ignoreMissing(vision.deleteProjectsLocationsProducts({ name }));

export const deleteReferenceImage = (name: string) =>
  name.length === 0
    ? Effect.void
    : ignoreMissing(
        vision.deleteProjectsLocationsProductsReferenceImages({ name }),
      );

export const syncProductSetMembership = (
  setName: string,
  project: string,
  location: string,
  desired: readonly string[] | undefined,
) =>
  Effect.gen(function* () {
    if (desired === undefined) return;
    const wanted = new Set(
      desired
        .filter((value) => value.length > 0)
        .map((value) => expandProductName(project, location, value)),
    );
    const observed = yield* listProductsInSet(setName);
    const present = new Set(
      observed
        .map((product) => product.name)
        .filter((name): name is string => typeof name === "string"),
    );
    for (const product of wanted) {
      if (present.has(product)) continue;
      yield* vision
        .addProductProjectsLocationsProductSets({
          name: setName,
          body: { product },
        })
        .pipe(
          Effect.catchTag("Conflict", () => Effect.void),
          Effect.catchTag("NotFound", () => Effect.void),
        );
    }
    for (const product of present) {
      if (wanted.has(product)) continue;
      yield* vision
        .removeProductProjectsLocationsProductSets({
          name: setName,
          body: { product },
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }
  });
