import * as mybiz from "@distilled.cloud/gcp/mybusinessbusinessinformation_v1";
import * as placeactions from "@distilled.cloud/gcp/mybusinessplaceactions_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const DEFAULT_PLACE_ACTION_TYPE: placeactions.PlaceActionLinkPlaceActionTypeEnum =
  "SHOP_ONLINE";
export const DEFAULT_ACCOUNT = "accounts/-";
export const LOCATION_READ_MASK = "name,labels";
export const PROBE_NAME =
  "locations/alchemy-missing/placeActionLinks/alchemy-missing";
export const PROBE_PARENT = "locations/alchemy-missing";
export const DEFAULT_URI_HOST = "https://example.com";

const OWNERSHIP_KEYS = [
  alchemyLabelKeys.stack,
  alchemyLabelKeys.stage,
  alchemyLabelKeys.id,
] as const;

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const locationParent = (parent: string | undefined) => {
  if (!parent || parent.length === 0) return "";
  if (parent.includes("/placeActionLinks/")) {
    return parentOfName(parent);
  }
  return parent.startsWith("locations/") ? parent : `locations/${parent}`;
};

export const parentOfName = (name: string) => {
  const idx = name.indexOf("/placeActionLinks/");
  return idx > 0 ? name.slice(0, idx) : "";
};

export const linkNameOf = (name: string | undefined) => {
  if (!name || name.length === 0) return "";
  return name;
};

export const linkIdOf = (name: string | undefined) => {
  const full = linkNameOf(name);
  return full.length === 0 ? "" : lastSegment(full);
};

const accountParent = (account: string | undefined) => {
  if (!account || account.length === 0) return DEFAULT_ACCOUNT;
  return account.startsWith("accounts/") ? account : `accounts/${account}`;
};

const splitEnv = (...values: Array<string | undefined>) =>
  values
    .flatMap((value) => (value ?? "").split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => locationParent(value))
    .filter((value) => value.length > 0);

export const parentsFromEnv = () =>
  splitEnv(
    process.env.GCP_MYBUSINESS_LOCATION,
    process.env.GCP_PLACE_ACTION_PARENT,
  );

export const accountFromEnv = () =>
  accountParent(process.env.GCP_MYBUSINESS_ACCOUNT?.trim());

const stripOwnershipParams = (search: string) => {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  for (const key of OWNERSHIP_KEYS) {
    params.delete(key);
  }
  const next = params.toString();
  return next.length > 0 ? `?${next}` : "";
};

const labelsFromParams = (search: string): Record<string, string> => {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const labels: Record<string, string> = {};
  for (const key of OWNERSHIP_KEYS) {
    const value = params.get(key);
    if (value && value.length > 0) labels[key] = value;
  }
  return labels;
};

export const parseUriOwnership = (
  uri: string | undefined,
): {
  labels: Record<string, string>;
  uri: string | undefined;
} => {
  if (!uri || uri.length === 0) return { labels: {}, uri };
  const hash = uri.indexOf("#");
  const withoutHash = hash >= 0 ? uri.slice(0, hash) : uri;
  const fragment = hash >= 0 ? uri.slice(hash) : "";
  const query = withoutHash.indexOf("?");
  const path = query >= 0 ? withoutHash.slice(0, query) : withoutHash;
  const search = query >= 0 ? withoutHash.slice(query) : "";
  return {
    labels: labelsFromParams(search),
    uri: path + stripOwnershipParams(search) + fragment,
  };
};

export const stampUri = (
  uri: string,
  labels: Record<string, string>,
): string => {
  const { uri: base } = parseUriOwnership(uri);
  const path = base && base.length > 0 ? base : uri;
  const hash = path.indexOf("#");
  const withoutHash = hash >= 0 ? path.slice(0, hash) : path;
  const fragment = hash >= 0 ? path.slice(hash) : "";
  const sep = withoutHash.includes("?") ? "&" : "?";
  return `${withoutHash}${sep}${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]}&${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]}&${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}${fragment}`;
};

export const hasOwnershipMarker = (uri: string | undefined) =>
  Object.keys(parseUriOwnership(uri).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

export const ownedByAlchemy = (id: string, uri: string | undefined) =>
  Effect.gen(function* () {
    const { labels } = parseUriOwnership(uri);
    return yield* hasAlchemyLabels(id, labels);
  });

export const ownershipLabels = (id: string) => createInternalLabels(id);

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const toGeneratedUri = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) return requested;
    if (existing !== undefined && existing.length > 0) {
      return parseUriOwnership(existing).uri ?? existing;
    }
    const generated = yield* createPhysicalName({
      id,
      maxLength: 40,
      lowercase: true,
    });
    return `${DEFAULT_URI_HOST}/${generated}`;
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

export const getLink = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(placeactions.getLocationsPlaceActionLinks({ name }));

export const listLinksAt = (parent: string) =>
  parent.length === 0
    ? emptyList<placeactions.PlaceActionLink>()
    : placeactions.listLocationsPlaceActionLinks
        .pages({ parent, pageSize: 100 })
        .pipe(
          Stream.flatMap((page) =>
            Stream.fromIterable(page.placeActionLinks ?? []),
          ),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            emptyList<placeactions.PlaceActionLink>(),
          ),
        );

export const listLocationsAt = (parent: string) =>
  mybiz.listAccountsLocations
    .pages({
      parent,
      readMask: LOCATION_READ_MASK,
      pageSize: 100,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.locations ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag(["NotFound", "Forbidden"], () =>
        emptyList<mybiz.Location>(),
      ),
    );

export const listParents = () =>
  Effect.gen(function* () {
    const fromEnv = parentsFromEnv();
    const locations = yield* listLocationsAt(accountFromEnv());
    const fromAccount = locations
      .filter((location) =>
        (location.labels ?? []).some((label) => label.startsWith("alchemy-")),
      )
      .map((location) => location.name)
      .filter((name): name is string => !!name && name.length > 0)
      .map((name) => locationParent(name));
    const seen = new Set<string>();
    const parents: string[] = [];
    for (const parent of [...fromEnv, ...fromAccount]) {
      if (parent.length === 0 || seen.has(parent)) continue;
      seen.add(parent);
      parents.push(parent);
    }
    return parents;
  });

export const listOwnedLinks = () =>
  Effect.gen(function* () {
    const parents = yield* listParents();
    const pages = yield* Effect.forEach(parents, listLinksAt, {
      concurrency: 4,
    });
    const seen = new Set<string>();
    const owned: placeactions.PlaceActionLink[] = [];
    for (const link of pages.flat()) {
      const key = link.name ?? link.uri ?? "";
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      if (hasOwnershipMarker(link.uri)) owned.push(link);
    }
    return owned;
  });

export const findOwnedLink = (
  id: string,
  input: {
    name?: string;
    parent?: string;
    uri?: string;
    placeActionType?: string;
  },
) =>
  Effect.gen(function* () {
    let existing = yield* getLink(input.name ?? "");
    if (existing !== undefined) return existing;
    const parent = locationParent(
      input.parent ?? parentOfName(input.name ?? ""),
    );
    const atParent =
      parent.length > 0
        ? yield* listLinksAt(parent)
        : ([] as placeactions.PlaceActionLink[]);
    const stamped = input.uri;
    const byIdentity = atParent.find((link) => {
      const parsed = parseUriOwnership(link.uri);
      return (
        (stamped !== undefined &&
          sameText(parsed.uri, parseUriOwnership(stamped).uri) &&
          sameText(link.placeActionType, input.placeActionType)) ||
        false
      );
    });
    if (byIdentity !== undefined) return byIdentity;
    for (const link of atParent) {
      if (yield* ownedByAlchemy(id, link.uri)) return link;
    }
    const owned = yield* listOwnedLinks();
    for (const link of owned) {
      if (yield* ownedByAlchemy(id, link.uri)) return link;
    }
    return undefined;
  });

export const deleteLink = (name: string) =>
  name.length === 0
    ? Effect.void
    : ignoreMissing(placeactions.deleteLocationsPlaceActionLinks({ name }));
