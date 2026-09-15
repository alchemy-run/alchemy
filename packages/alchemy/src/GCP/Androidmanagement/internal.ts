import * as androidmanagement from "@distilled.cloud/gcp/androidmanagement_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const ENTERPRISE_PREFIX = "enterprises/";
export const MAX_DISPLAY_NAME_LENGTH = 100;
export const MAX_WEB_APP_TITLE_LENGTH = 100;
export const MAX_ADDITIONAL_DATA_LENGTH = 1024;
export const DEFAULT_DURATION = "315360000s";
export const DEFAULT_DISPLAY_MODE = "STANDALONE";
export const DEFAULT_START_URL = "https://example.com/";
export const PROBE_ENTERPRISE = "enterprises/alchemy-missing-enterprise";
export const PROBE_ENROLLMENT_TOKEN = `${PROBE_ENTERPRISE}/enrollmentTokens/alchemy-missing`;
export const PROBE_WEB_APP = `${PROBE_ENTERPRISE}/webApps/com.alchemy.missing`;

export const DEFAULT_WEB_APP_ICON: androidmanagement.WebAppIcon = {
  imageData:
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
};

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const parentOf = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  return parts.slice(0, -2).join("/");
};

export const normalizeName = (value: string) => value.replace(/\/+$/, "");

export const toEnterpriseName = (value: string) => {
  const trimmed = normalizeName(value);
  if (trimmed.length === 0) return "";
  if (trimmed.startsWith(ENTERPRISE_PREFIX)) return trimmed;
  return `${ENTERPRISE_PREFIX}${trimmed}`;
};

export const toEnrollmentTokenName = (parent: string, tokenId?: string) => {
  if (tokenId !== undefined && tokenId.includes("/enrollmentTokens/")) {
    return normalizeName(tokenId);
  }
  if (tokenId !== undefined && tokenId.length > 0 && parent.length > 0) {
    return `${toEnterpriseName(parent)}/enrollmentTokens/${lastSegment(tokenId)}`;
  }
  return "";
};

export const toWebAppName = (parent: string, webAppId?: string) => {
  if (webAppId !== undefined && webAppId.includes("/webApps/")) {
    return normalizeName(webAppId);
  }
  if (webAppId !== undefined && webAppId.length > 0 && parent.length > 0) {
    return `${toEnterpriseName(parent)}/webApps/${lastSegment(webAppId)}`;
  }
  return "";
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameBoolean = (
  left: boolean | undefined,
  right: boolean | undefined,
) => (left ?? false) === (right ?? false);

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
    toEnterpriseName(input.previousParent) !==
      toEnterpriseName(input.nextParent)
  ) {
    return { action: "replace" as const, deleteFirst: true };
  }
  return undefined;
};

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

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_ADDITIONAL_DATA_LENGTH,
): string => {
  const marker = fitMarker(labels, Math.min(800, maxLength));
  const trimmed = text?.trim();
  const combined =
    trimmed && trimmed.length > 0 ? `${marker}\n${trimmed}` : marker;
  return combined.slice(0, maxLength);
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

export const toDisplayName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = MAX_DISPLAY_NAME_LENGTH,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return requested.slice(0, maxLength);
    }
    if (existing !== undefined && existing.length > 0) {
      return existing.slice(0, maxLength);
    }
    return yield* createPhysicalName({
      id,
      maxLength: Math.min(40, maxLength),
      lowercase: true,
    });
  });

export const enterpriseNamesFromEnv = () => {
  const raw = process.env.GCP_ANDROIDMANAGEMENT_ENTERPRISE?.trim();
  if (!raw) return [] as string[];
  return raw
    .split(/[,\s]+/)
    .filter((name) => name.length > 0)
    .map(toEnterpriseName);
};

const emptyList = <A>() => Effect.succeed([] as A[]);

export const collectPages = <Page, A, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly A[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

export const getEnterprise = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : androidmanagement.getEnterprises({ name: toEnterpriseName(name) }).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
      );

export const getEnrollmentToken = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : androidmanagement.getEnterprisesEnrollmentTokens({ name }).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
      );

export const getWebApp = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : androidmanagement.getEnterprisesWebApps({ name }).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
      );

export const listEnterprisesAt = (projectId: string) =>
  projectId.length === 0
    ? emptyList<androidmanagement.Enterprise>()
    : collectPages(
        androidmanagement.listEnterprises.pages({
          projectId,
          view: "BASIC",
          pageSize: 100,
        }),
        (page) => page.enterprises,
      ).pipe(
        Effect.catchTag(["NotFound", "Forbidden"], () =>
          emptyList<androidmanagement.Enterprise>(),
        ),
      );

export const listEnrollmentTokensAt = (parent: string) =>
  parent.length === 0
    ? emptyList<androidmanagement.EnrollmentToken>()
    : collectPages(
        androidmanagement.listEnterprisesEnrollmentTokens.pages({
          parent: toEnterpriseName(parent),
          pageSize: 100,
        }),
        (page) => page.enrollmentTokens,
      ).pipe(
        Effect.catchTag(["NotFound", "Forbidden"], () =>
          emptyList<androidmanagement.EnrollmentToken>(),
        ),
      );

export const listWebAppsAt = (parent: string) =>
  parent.length === 0
    ? emptyList<androidmanagement.WebApp>()
    : collectPages(
        androidmanagement.listEnterprisesWebApps.pages({
          parent: toEnterpriseName(parent),
          pageSize: 100,
        }),
        (page) => page.webApps,
      ).pipe(
        Effect.catchTag(["NotFound", "Forbidden"], () =>
          emptyList<androidmanagement.WebApp>(),
        ),
      );

const hydrateEnterprise = (enterprise: androidmanagement.Enterprise) =>
  Effect.gen(function* () {
    if (
      enterprise.enterpriseDisplayName !== undefined &&
      enterprise.enterpriseDisplayName.length > 0
    ) {
      return enterprise;
    }
    const name = enterprise.name ?? "";
    if (name.length === 0) return enterprise;
    return (yield* getEnterprise(name)) ?? enterprise;
  });

export const isOwnedEnterprise = (enterprise: androidmanagement.Enterprise) =>
  hasOwnershipMarker(enterprise.enterpriseDisplayName);

export const listCandidateEnterprises = (projectId: string) =>
  Effect.gen(function* () {
    const listed = yield* listEnterprisesAt(projectId);
    const extra = yield* Effect.forEach(
      enterpriseNamesFromEnv(),
      (name) => getEnterprise(name),
      { concurrency: 4 },
    );
    const byName = new Map<string, androidmanagement.Enterprise>();
    for (const enterprise of [...listed, ...extra]) {
      if (enterprise === undefined) continue;
      const name = enterprise.name ?? "";
      if (name.length === 0) continue;
      byName.set(name, enterprise);
    }
    const hydrated = yield* Effect.forEach(
      Array.from(byName.values()),
      (enterprise) => hydrateEnterprise(enterprise),
      { concurrency: 4 },
    );
    return hydrated;
  });

export const listOwnedEnterprises = (projectId: string) =>
  listCandidateEnterprises(projectId).pipe(
    Effect.map((enterprises) => enterprises.filter(isOwnedEnterprise)),
  );

export const findOwnedEnterprise = (id: string, projectId: string) =>
  Effect.gen(function* () {
    const enterprises = yield* listCandidateEnterprises(projectId);
    for (const enterprise of enterprises) {
      if (yield* ownedByAlchemy(id, enterprise.enterpriseDisplayName)) {
        return enterprise;
      }
    }
    return undefined;
  });

export const findOwnedEnrollmentToken = (
  id: string,
  parent: string,
  name?: string,
) =>
  Effect.gen(function* () {
    const direct = yield* getEnrollmentToken(
      toEnrollmentTokenName(parent, name),
    );
    if (direct !== undefined) return direct;
    const tokens = yield* listEnrollmentTokensAt(parent);
    for (const token of tokens) {
      if (yield* ownedByAlchemy(id, token.additionalData)) {
        return token;
      }
    }
    return undefined;
  });

export const findOwnedWebApp = (
  id: string,
  parent: string,
  input: { name?: string; startUrl?: string },
) =>
  Effect.gen(function* () {
    const direct = yield* getWebApp(toWebAppName(parent, input.name));
    if (direct !== undefined) return direct;
    const apps = yield* listWebAppsAt(parent);
    for (const app of apps) {
      if (yield* ownedByAlchemy(id, app.title)) {
        return app;
      }
    }
    if (input.startUrl !== undefined && input.startUrl.length > 0) {
      return apps.find(
        (app) =>
          sameText(app.startUrl, input.startUrl) &&
          hasOwnershipMarker(app.title),
      );
    }
    return undefined;
  });

export const listOwnedEnrollmentTokens = (projectId: string) =>
  Effect.gen(function* () {
    const enterprises = yield* listOwnedEnterprises(projectId);
    const pages = yield* Effect.forEach(
      enterprises,
      (enterprise) =>
        enterprise.name
          ? listEnrollmentTokensAt(enterprise.name)
          : emptyList<androidmanagement.EnrollmentToken>(),
      { concurrency: 4 },
    );
    return pages.flat();
  });

export const listOwnedWebApps = (projectId: string) =>
  Effect.gen(function* () {
    const enterprises = yield* listOwnedEnterprises(projectId);
    const pages = yield* Effect.forEach(
      enterprises,
      (enterprise) =>
        enterprise.name
          ? listWebAppsAt(enterprise.name)
          : emptyList<androidmanagement.WebApp>(),
      { concurrency: 4 },
    );
    return pages.flat().filter((app) => hasOwnershipMarker(app.title));
  });

export const defaultWebAppIcons = (
  icons: readonly androidmanagement.WebAppIcon[] | undefined,
): androidmanagement.WebAppIcon[] =>
  icons && icons.length > 0 ? [...icons] : [DEFAULT_WEB_APP_ICON];
