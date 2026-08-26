import * as retail from "@distilled.cloud/gcp/retail_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const DEFAULT_LOCATION = "global";
export const DEFAULT_CATALOG = "default_catalog";
export const DEFAULT_BRANCH = "default_branch";
export const MAX_ID_LENGTH = 63;
export const MAX_MODEL_ID_LENGTH = 40;
export const MAX_PRODUCT_ID_LENGTH = 128;
export const MAX_DISPLAY_NAME_LENGTH = 128;
export const MAX_MODEL_DISPLAY_NAME_LENGTH = 1024;

export class RetailNotResolved extends Data.TaggedError(
  "GCP.Retail.ResourceNotResolved",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const parentOf = (name: string, collection?: string) => {
  if (collection !== undefined) {
    const marker = `/${collection}/`;
    const index = name.lastIndexOf(marker);
    return index >= 0 ? name.slice(0, index) : name;
  }
  const parts = name.split("/").filter((part) => part.length > 0);
  return parts.slice(0, -2).join("/");
};

export const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

export const normalizeCatalog = (catalog: string | undefined) =>
  lastSegment(catalog ?? DEFAULT_CATALOG);

export const normalizeBranch = (branch: string | undefined) =>
  lastSegment(branch ?? DEFAULT_BRANCH);

export const locationParent = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

export const catalogName = (
  project: string,
  location: string,
  catalogId: string,
) => `${locationParent(project, location)}/catalogs/${catalogId}`;

export const expandCatalog = (
  value: string | undefined,
  project: string,
  location: string,
) => {
  const raw = (value ?? DEFAULT_CATALOG).replace(/\/+$/, "");
  if (raw.includes("/")) return raw;
  return catalogName(project, location, raw);
};

export const branchName = (catalog: string, branchId: string) =>
  `${catalog}/branches/${branchId}`;

export const parseResourceName = (name: string, collection: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  const catalogsAt = parts.lastIndexOf("catalogs");
  const branchesAt = parts.lastIndexOf("branches");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : DEFAULT_LOCATION,
    catalogId:
      catalogsAt >= 0 && parts[catalogsAt + 1]
        ? parts[catalogsAt + 1]!
        : DEFAULT_CATALOG,
    catalog:
      catalogsAt >= 0
        ? parts.slice(0, catalogsAt + 2).join("/")
        : parentOf(name),
    branchId:
      branchesAt >= 0 && parts[branchesAt + 1]
        ? parts[branchesAt + 1]!
        : DEFAULT_BRANCH,
    id:
      collectionAt >= 0 && parts[collectionAt + 1]
        ? parts[collectionAt + 1]!
        : lastSegment(name),
    parent:
      collectionAt > 0
        ? parts.slice(0, collectionAt).join("/")
        : parts.slice(0, Math.max(0, parts.length - 1)).join("/"),
  };
};

export const slugNoDigits = (
  name: string,
  maxLength: number,
  minLength = 4,
): string => {
  let next = name
    .toLowerCase()
    .replace(/[0-9]/g, (digit) => "abcdefghij"[Number(digit)]!)
    .replace(/[^a-z_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `r${next}`;
  next = next.slice(0, maxLength).replace(/[-_]+$/g, "");
  if (next.length < minLength) next = `${next}xxxx`.slice(0, minLength);
  return next.length > 0 ? next : "resource";
};

export const productIdOf = (
  name: string,
  maxLength = MAX_PRODUCT_ID_LENGTH,
) => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `p${next}`;
  next = next.slice(0, maxLength).replace(/[-_]+$/g, "");
  return next.length > 0 ? next : "product";
};

export const toPhysical = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  format: (name: string) => string,
  maxLength: number,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    return format(
      yield* createPhysicalName({
        id,
        maxLength,
        lowercase: true,
      }),
    );
  });

const markerOf = (labels: Record<string, string>) =>
  `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
  separator: "\n" | " " = "\n",
): string => {
  const marker = markerOf(labels);
  const trimmed = text?.trim();
  return trimmed && trimmed.length > 0
    ? `${marker}${separator}${trimmed}`
    : marker;
};

const compactMarkerOf = (labels: Record<string, string>) =>
  `[alc ${labels[alchemyLabelKeys.stack]}|${labels[alchemyLabelKeys.stage]}|${labels[alchemyLabelKeys.id]}]`;

export const encodeOwnershipLine = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_DISPLAY_NAME_LENGTH,
): string => {
  const marker = compactMarkerOf(labels);
  const trimmed = text?.trim();
  if (!trimmed) return marker.slice(0, maxLength);
  const combined = `${trimmed} ${marker}`;
  if (combined.length <= maxLength) return combined;
  const budget = maxLength - marker.length - 1;
  if (budget <= 0) return marker.slice(0, maxLength);
  return `${trimmed.slice(0, budget)} ${marker}`.slice(0, maxLength);
};

const parseOwnershipMarker = (text: string) => {
  const labels: Record<string, string> = {};
  const end = text.indexOf("]");
  if (end < 0) return { labels, rest: text };
  for (const part of text.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  return { labels, rest: text.slice(end + 1) };
};

const parseCompactMarker = (text: string) => {
  const end = text.indexOf("]");
  if (!text.startsWith("[alc ") || end < 0) {
    return { labels: {} as Record<string, string>, rest: text };
  }
  const parts = text.slice("[alc ".length, end).split("|");
  const labels: Record<string, string> = {};
  if (parts[0]) labels[alchemyLabelKeys.stack] = parts[0];
  if (parts[1]) labels[alchemyLabelKeys.stage] = parts[1];
  if (parts[2]) labels[alchemyLabelKeys.id] = parts[2];
  return { labels, rest: text.slice(end + 1) };
};

export const parseOwnership = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (!text) return { labels: {}, text };
  const compactAt = text.indexOf("[alc ");
  const verboseAt = text.indexOf("[alchemy ");
  if (verboseAt >= 0 && (compactAt < 0 || verboseAt <= compactAt)) {
    const before = text.slice(0, verboseAt).trim();
    const parsed = parseOwnershipMarker(text.slice(verboseAt));
    const after = parsed.rest.replace(/^[\s\n]+/, "");
    const combined = [before, after]
      .filter((part) => part.length > 0)
      .join(" ");
    return {
      labels: parsed.labels,
      text: combined.length > 0 ? combined : undefined,
    };
  }
  if (compactAt >= 0) {
    const before = text.slice(0, compactAt).trim();
    const parsed = parseCompactMarker(text.slice(compactAt));
    const after = parsed.rest.replace(/^[\s\n]+/, "");
    const combined = [before, after]
      .filter((part) => part.length > 0)
      .join(" ");
    return {
      labels: parsed.labels,
      text: combined.length > 0 ? combined : undefined,
    };
  }
  return { labels: {}, text };
};

export const hasOwnershipMarker = (text: string | undefined) =>
  Object.keys(parseOwnership(text).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

export const ownedByAlchemy = (id: string, text: string | undefined) =>
  Effect.gen(function* () {
    const { labels } = parseOwnership(text);
    return yield* hasAlchemyLabels(id, labels);
  });

export const ownershipLabels = (id: string) => createInternalLabels(id);

export const canonical = (value: unknown): unknown => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return value.length === 0 ? undefined : value;
  }
  if (Array.isArray(value)) {
    const items = value.map(canonical).filter((item) => item !== undefined);
    return items.length === 0 ? undefined : items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, canonical(item)] as const)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) return undefined;
    return Object.fromEntries(entries);
  }
  return undefined;
};

export const fingerprint = (value: unknown): string =>
  JSON.stringify(canonical(value) ?? null);

export const sameJson = (left: unknown, right: unknown) =>
  fingerprint(left) === fingerprint(right);

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  fingerprint([...(left ?? [])].sort()) ===
  fingerprint([...(right ?? [])].sort());

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const replaceOnIdentity = (input: {
  previousId?: string;
  nextId?: string;
  previousParent?: string;
  nextParent?: string;
}) => {
  const idChanged =
    input.previousId !== undefined &&
    input.nextId !== undefined &&
    input.previousId !== input.nextId;
  const parentChanged =
    (input.previousParent ?? "") !== "" &&
    (input.nextParent ?? "") !== "" &&
    (input.previousParent ?? "") !== (input.nextParent ?? "");
  if (!idChanged && !parentChanged) return undefined;
  return {
    action: "replace" as const,
    deleteFirst:
      !parentChanged &&
      input.previousId !== undefined &&
      input.nextId === input.previousId,
  };
};

const emptyList = <A>() => Effect.succeed<A[]>([]);

export const collectPages = <Page, Item, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly Item[] | null | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk) as Item[]),
  );

export const LIST_LOCATIONS = ["global", "us-central1"] as const;

export const listCatalogs = (project: string, location: string) =>
  collectPages(
    retail.listProjectsLocationsCatalogs.pages({
      parent: locationParent(project, location),
      pageSize: 100,
    }),
    (page) => page.catalogs,
  ).pipe(
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      emptyList<retail.GoogleCloudRetailV2Catalog>(),
    ),
  );

export const listProjectCatalogs = (project: string) =>
  Effect.forEach(
    LIST_LOCATIONS,
    (location) => listCatalogs(project, location),
    { concurrency: 2 },
  ).pipe(
    Effect.map((groups) => {
      const seen = new Set<string>();
      const catalogs: retail.GoogleCloudRetailV2Catalog[] = [];
      for (const catalog of groups.flat()) {
        const name = catalog.name ?? "";
        if (name.length === 0 || seen.has(name)) continue;
        seen.add(name);
        catalogs.push(catalog);
      }
      return catalogs;
    }),
  );

export const listControls = (parent: string) =>
  parent.length === 0
    ? emptyList<retail.GoogleCloudRetailV2Control>()
    : collectPages(
        retail.listProjectsLocationsCatalogsControls.pages({
          parent,
          pageSize: 100,
        }),
        (page) => page.controls,
      ).pipe(
        Effect.catchTag(["NotFound", "Forbidden"], () =>
          emptyList<retail.GoogleCloudRetailV2Control>(),
        ),
      );

export const listServingConfigs = (parent: string) =>
  parent.length === 0
    ? emptyList<retail.GoogleCloudRetailV2ServingConfig>()
    : collectPages(
        retail.listProjectsLocationsCatalogsServingConfigs.pages({
          parent,
          pageSize: 100,
        }),
        (page) => page.servingConfigs,
      ).pipe(
        Effect.catchTag(["NotFound", "Forbidden"], () =>
          emptyList<retail.GoogleCloudRetailV2ServingConfig>(),
        ),
      );

export const listModels = (parent: string) =>
  parent.length === 0
    ? emptyList<retail.GoogleCloudRetailV2Model>()
    : collectPages(
        retail.listProjectsLocationsCatalogsModels.pages({
          parent,
          pageSize: 100,
        }),
        (page) => page.models,
      ).pipe(
        Effect.catchTag(["NotFound", "Forbidden"], () =>
          emptyList<retail.GoogleCloudRetailV2Model>(),
        ),
      );

export const listProducts = (parent: string) =>
  parent.length === 0
    ? emptyList<retail.GoogleCloudRetailV2Product>()
    : collectPages(
        retail.listProjectsLocationsCatalogsBranchesProducts.pages({
          parent,
          pageSize: 100,
          readMask: "*",
        }),
        (page) => page.products,
      ).pipe(
        Effect.catchTag(["NotFound", "Forbidden"], () =>
          emptyList<retail.GoogleCloudRetailV2Product>(),
        ),
      );

export const productHasOwnership = (
  product: retail.GoogleCloudRetailV2Product,
) =>
  hasOwnershipMarker(product.description) ||
  (product.tags ?? []).some((tag) => hasOwnershipMarker(tag));

export const productOwnedByAlchemy = (
  id: string,
  product: retail.GoogleCloudRetailV2Product,
) =>
  Effect.gen(function* () {
    if (yield* ownedByAlchemy(id, product.description)) return true;
    for (const tag of product.tags ?? []) {
      if (yield* ownedByAlchemy(id, tag)) return true;
    }
    return false;
  });
