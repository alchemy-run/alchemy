import * as adsenseplatform from "@distilled.cloud/gcp/adsenseplatform_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
  sanitizeLabelValue,
} from "../Labels.ts";

export const MAX_DOMAIN_LENGTH = 253;
export const MAX_LABEL_LENGTH = 63;
export const DEFAULT_DOMAIN_SUFFIX = "alchemy-gcp-testing.com";
export const OWNERSHIP_LABEL = "alch";
export const PROBE_PARENT =
  "platforms/pub-0000000000000000/accounts/pub-0000000000000000";
export const PROBE_NAME = `${PROBE_PARENT}/sites/alchemy-missing`;

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const normalizeResourceName = (value: string) =>
  value.replace(/\/+$/, "").trim();

export const parentOf = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  if (parts.length < 2) return "";
  return parts.slice(0, -2).join("/");
};

export const toPlatformName = (value: string) => {
  const trimmed = normalizeResourceName(value);
  if (trimmed.length === 0) return trimmed;
  return trimmed.startsWith("platforms/") ? trimmed : `platforms/${trimmed}`;
};

export const toParent = (value: string) => {
  const trimmed = normalizeResourceName(value);
  if (trimmed.length === 0) return trimmed;
  if (trimmed.includes("/accounts/")) {
    return trimmed.startsWith("platforms/") ? trimmed : `platforms/${trimmed}`;
  }
  return trimmed;
};

export const toAccountParent = (platform: string, account: string) => {
  const trimmed = normalizeResourceName(account);
  if (trimmed.includes("/accounts/")) return toParent(trimmed);
  const platformName = toPlatformName(platform);
  const id = trimmed.startsWith("accounts/") ? lastSegment(trimmed) : trimmed;
  return `${platformName}/accounts/${id}`;
};

export const resourceName = (parent: string, siteId: string) =>
  `${normalizeResourceName(parent)}/sites/${siteId}`;

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const normalizeDomain = (value: string | undefined) =>
  (value ?? "").trim().toLowerCase().replace(/\.$/, "");

export const replaceOnIdentity = (input: {
  previousParent?: string;
  nextParent: string;
  previousDomain?: string;
  nextDomain?: string;
}) => {
  if (
    input.previousParent !== undefined &&
    input.previousParent.length > 0 &&
    input.previousParent !== input.nextParent
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousDomain !== undefined &&
    input.previousDomain.length > 0 &&
    input.nextDomain !== undefined &&
    input.nextDomain.length > 0 &&
    normalizeDomain(input.previousDomain) !== normalizeDomain(input.nextDomain)
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  return undefined;
};

const dnsLabel = (value: string) => {
  const cleaned = sanitizeLabelValue(value)
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "");
  const label = (cleaned.length > 0 ? cleaned : "x").slice(0, MAX_LABEL_LENGTH);
  return /^[a-z]/.test(label) ? label : `x${label}`.slice(0, MAX_LABEL_LENGTH);
};

const markerLabels = (stack: string, stage: string, id: string) => [
  OWNERSHIP_LABEL,
  dnsLabel(stack),
  dnsLabel(stage),
  dnsLabel(id),
];

const fitMarkerLabels = (labels: Record<string, string>) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerLabels(stack, stage, id);
  while (
    marker.some((label) => label.length > MAX_LABEL_LENGTH) &&
    (stack.length > 1 || stage.length > 1 || id.length > 1)
  ) {
    if (id.length >= stack.length && id.length >= stage.length) {
      id = id.slice(0, -1);
    } else if (stack.length >= stage.length) {
      stack = stack.slice(0, -1);
    } else {
      stage = stage.slice(0, -1);
    }
    marker = markerLabels(stack, stage, id);
  }
  return marker;
};

export const parseDomain = (
  domain: string | undefined,
): {
  labels: Record<string, string>;
  domain: string | undefined;
} => {
  const normalized = normalizeDomain(domain);
  if (normalized.length === 0) return { labels: {}, domain };
  const parts = normalized.split(".").filter((part) => part.length > 0);
  if (parts.length >= 5 && parts[0] === OWNERSHIP_LABEL) {
    return {
      labels: {
        [alchemyLabelKeys.stack]: parts[1] ?? "",
        [alchemyLabelKeys.stage]: parts[2] ?? "",
        [alchemyLabelKeys.id]: parts[3] ?? "",
      },
      domain: parts.slice(4).join("."),
    };
  }
  return { labels: {}, domain: normalized };
};

export const encodeDomain = (
  labels: Record<string, string>,
  domain: string,
): string => {
  const rest = parseDomain(domain).domain ?? normalizeDomain(domain);
  const restLabels = rest.split(".").filter((part) => part.length > 0);
  const marker = fitMarkerLabels(labels);
  let encoded = [...marker, ...restLabels].join(".");
  while (encoded.length > MAX_DOMAIN_LENGTH && restLabels.length > 1) {
    restLabels.pop();
    encoded = [...marker, ...restLabels].join(".");
  }
  return encoded.slice(0, MAX_DOMAIN_LENGTH);
};

export const hasOwnershipMarker = (domain: string | undefined) =>
  Object.keys(parseDomain(domain).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (id: string, domain: string | undefined) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const { labels } = parseDomain(domain);
    if (!hasOwnershipMarker(domain)) return false;
    const exact = yield* hasAlchemyLabels(id, labels);
    if (exact) return true;
    return (
      prefixMatch(
        dnsLabel(expected[alchemyLabelKeys.stack] ?? ""),
        labels[alchemyLabelKeys.stack] ?? "",
      ) &&
      prefixMatch(
        dnsLabel(expected[alchemyLabelKeys.stage] ?? ""),
        labels[alchemyLabelKeys.stage] ?? "",
      ) &&
      prefixMatch(
        dnsLabel(expected[alchemyLabelKeys.id] ?? ""),
        labels[alchemyLabelKeys.id] ?? "",
      )
    );
  });

export const ownershipLabels = (id: string) => createInternalLabels(id);

export const toUserDomain = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return parseDomain(requested).domain ?? normalizeDomain(requested);
    }
    if (existing !== undefined && existing.length > 0) {
      return parseDomain(existing).domain ?? normalizeDomain(existing);
    }
    const physical = yield* createPhysicalName({
      id,
      maxLength: 40,
      lowercase: true,
    });
    const label = dnsLabel(physical);
    return `${label}.${DEFAULT_DOMAIN_SUFFIX}`;
  });

const emptyList = <A>() => Effect.succeed([] as A[]);

export const collectPages = <A, Page, E, R>(
  pages: Stream.Stream<Page, E, R>,
  pick: (page: Page) => readonly A[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(pick(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

export const ignoreMissing = <A, R>(
  effect: Effect.Effect<
    A,
    adsenseplatform.DeletePlatformsAccountsSitesError,
    R
  >,
) =>
  effect.pipe(
    Effect.catchTag("NotFound", () => Effect.void),
    Effect.catchTag("Forbidden", () => Effect.void),
  );

export const getSite = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : adsenseplatform.getPlatformsAccountsSites({ name }).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
      );

export const listAccounts = (parent: string) =>
  parent.length === 0
    ? emptyList<adsenseplatform.Account>()
    : collectPages(
        adsenseplatform.listPlatformsAccounts.pages({
          parent,
          pageSize: 200,
        }),
        (page) => page.accounts,
      ).pipe(
        Effect.catchTag("NotFound", () => emptyList<adsenseplatform.Account>()),
        Effect.catchTag("Forbidden", () =>
          emptyList<adsenseplatform.Account>(),
        ),
      );

export const listSites = (parent: string) =>
  parent.length === 0
    ? emptyList<adsenseplatform.Site>()
    : collectPages(
        adsenseplatform.listPlatformsAccountsSites.pages({
          parent,
          pageSize: 200,
        }),
        (page) => page.sites,
      ).pipe(
        Effect.catchTag("NotFound", () => emptyList<adsenseplatform.Site>()),
        Effect.catchTag("Forbidden", () => emptyList<adsenseplatform.Site>()),
      );

const valuesFromEnv = (keys: readonly string[]) => {
  const values: string[] = [];
  for (const key of keys) {
    const raw = process.env[key]?.trim();
    if (!raw) continue;
    for (const part of raw.split(/[,\s]+/)) {
      if (part.length > 0) values.push(part);
    }
  }
  return values;
};

export const platformsFromEnv = () => [
  ...new Set(
    valuesFromEnv([
      "GCP_ADSENSEPLATFORM_PLATFORM",
      "GCP_ADSENSEPLATFORM_PLATFORM_ID",
    ]).map(toPlatformName),
  ),
];

export const parentsFromEnv = () => {
  const names = new Set<string>();
  for (const parent of valuesFromEnv([
    "GCP_ADSENSEPLATFORM_PARENT",
    "GCP_ADSENSEPLATFORM_PARENTS",
  ])) {
    names.add(toParent(parent));
  }
  const platforms = platformsFromEnv();
  const accounts = valuesFromEnv([
    "GCP_ADSENSEPLATFORM_ACCOUNT",
    "GCP_ADSENSEPLATFORM_ACCOUNT_ID",
  ]);
  for (const platform of platforms) {
    for (const account of accounts) {
      names.add(toAccountParent(platform, account));
    }
  }
  return [...names];
};

export const listParents = () =>
  Effect.gen(function* () {
    const names = new Set(parentsFromEnv());
    const platforms = platformsFromEnv();
    const pages = yield* Effect.forEach(
      platforms,
      (platform) => listAccounts(platform),
      { concurrency: 4 },
    );
    for (const accounts of pages) {
      for (const account of accounts) {
        if (account.name) names.add(toParent(account.name));
      }
    }
    return [...names];
  });

export const listAllSites = () =>
  Effect.gen(function* () {
    const parents = yield* listParents();
    const pages = yield* Effect.forEach(
      parents,
      (parent) => listSites(parent),
      {
        concurrency: 4,
      },
    );
    return pages.flat();
  });

export const listOwnedSites = () =>
  listAllSites().pipe(
    Effect.map((sites) =>
      sites.filter((site) => hasOwnershipMarker(site.domain)),
    ),
  );

export const findOwnedSite = (id: string, parent?: string) =>
  Effect.gen(function* () {
    const rows =
      parent && parent.length > 0
        ? yield* listSites(parent)
        : yield* listAllSites();
    for (const row of rows) {
      if (yield* ownedByAlchemy(id, row.domain)) {
        return row;
      }
    }
    return undefined;
  });

export const findSiteByDomain = (domain: string, parent?: string) =>
  Effect.gen(function* () {
    const wanted = normalizeDomain(domain);
    const rows =
      parent && parent.length > 0
        ? yield* listSites(parent)
        : yield* listAllSites();
    return rows.find((row) => normalizeDomain(row.domain) === wanted);
  });
