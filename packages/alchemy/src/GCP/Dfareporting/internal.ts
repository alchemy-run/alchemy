import * as dfa from "@distilled.cloud/gcp/dfareporting_v5";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const MAX_NAME_LENGTH = 255;

export type UserRolePermissionValue = {
  /** User role permission id. */
  id?: string;
  /** Permission name. */
  name?: string;
  /**
   * Availability (`ACCOUNT_BY_DEFAULT`, `ACCOUNT_ALWAYS`,
   * `SUBACCOUNT_AND_ACCOUNT_BY_DEFAULT`, …).
   */
  availability?: string;
  /** Permission group id. */
  permissionGroupId?: string;
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

const canonical = (value: unknown): unknown => {
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

export const permissionIdsOf = (
  list: readonly UserRolePermissionValue[] | undefined,
): string[] =>
  [...(list ?? [])]
    .map((permission) => permission.id)
    .filter((id): id is string => !!id)
    .sort();

export const samePermissions = (
  left: readonly UserRolePermissionValue[] | undefined,
  right: readonly UserRolePermissionValue[] | undefined,
) => fingerprint(permissionIdsOf(left)) === fingerprint(permissionIdsOf(right));

export const toPermissionBody = (
  list: readonly UserRolePermissionValue[] | undefined,
): dfa.UserRolePermission[] | undefined => {
  if (list === undefined) return undefined;
  return list.map((permission) => ({
    id: permission.id,
    name: permission.name,
    availability: permission.availability,
    permissionGroupId: permission.permissionGroupId,
  }));
};

export const permissionsOf = (
  list: readonly dfa.UserRolePermission[] | undefined,
): UserRolePermissionValue[] =>
  (list ?? []).map((permission) => ({
    id: permission.id,
    name: permission.name,
    availability: permission.availability,
    permissionGroupId: permission.permissionGroupId,
  }));

export const toRoleName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined) return requested;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: 40,
      lowercase: true,
    });
    return /^[a-z]/.test(generated) ? generated : `r${generated}`.slice(0, 40);
  });

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
  maxLength = MAX_NAME_LENGTH,
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

export const profileIdFromEnv = () =>
  process.env.GCP_DFAREPORTING_PROFILE_ID?.trim() || undefined;

export const parentUserRoleIdFromEnv = () =>
  process.env.GCP_DFAREPORTING_PARENT_USER_ROLE_ID?.trim() || undefined;

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

export const listProfiles = () =>
  dfa.listUserProfiles({}).pipe(
    Effect.map((response) =>
      (response.items ?? []).filter(
        (profile): profile is dfa.UserProfile & { profileId: string } =>
          !!profile.profileId,
      ),
    ),
    ignoreList([] as Array<dfa.UserProfile & { profileId: string }>),
  );

export const listRoles = (
  profileId: string,
  options?: {
    searchString?: string;
    accountUserRoleOnly?: boolean;
    ids?: string[];
  },
) =>
  dfa.listUserRoles
    .pages({
      profileId,
      maxResults: 1000,
      searchString: options?.searchString,
      accountUserRoleOnly: options?.accountUserRoleOnly,
      ids: options?.ids,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.userRoles ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      ignoreList([] as dfa.UserRole[]),
    );

export const getRole = (
  profileId: string | undefined,
  id: string | undefined,
) =>
  !profileId || !id
    ? Effect.succeed(undefined)
    : dfa
        .getUserRoles({ profileId, id })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const findRoleByName = (profileId: string, name: string) =>
  listRoles(profileId, { searchString: "alchemy" }).pipe(
    Effect.map((roles) => roles.find((role) => role.name === name)),
  );

export const findDefaultParentRoleId = (profileId: string) =>
  listRoles(profileId, { accountUserRoleOnly: true }).pipe(
    Effect.map((roles) => {
      const def = roles.find(
        (role) => role.defaultUserRole === true && !!role.id,
      );
      return def?.id;
    }),
  );

export const resolveParentUserRoleId = (
  profileId: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested) return requested;
    if (existing) return existing;
    const fromEnv = parentUserRoleIdFromEnv();
    if (fromEnv) return fromEnv;
    const discovered = yield* findDefaultParentRoleId(profileId);
    if (discovered) return discovered;
    return undefined;
  });

export const MAX_FLOODLIGHT_NAME_LENGTH = 128;
export const MAX_NOTES_LENGTH = 8000;

export const advertiserIdFromEnv = () =>
  process.env.GCP_DFAREPORTING_ADVERTISER_ID?.trim() || undefined;

export const campaignIdFromEnv = () =>
  process.env.GCP_DFAREPORTING_CAMPAIGN_ID?.trim() || undefined;

export const siteIdFromEnv = () =>
  process.env.GCP_DFAREPORTING_SITE_ID?.trim() || undefined;

export const floodlightActivityGroupIdFromEnv = () =>
  process.env.GCP_DFAREPORTING_FLOODLIGHT_ACTIVITY_GROUP_ID?.trim() ||
  undefined;

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const sameBool = (
  left: boolean | undefined,
  right: boolean | undefined,
) => (left === true) === (right === true);

export const sameNumber = (
  left: number | undefined,
  right: number | undefined,
) => (left ?? 0) === (right ?? 0);

export const jsonEqual = sameJson;

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

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
): string => {
  const marker = fitMarker(labels, MAX_NOTES_LENGTH);
  const trimmed = text?.trim();
  return trimmed && trimmed.length > 0 ? `${marker}\n${trimmed}` : marker;
};

export const ownedName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = MAX_NAME_LENGTH,
) =>
  Effect.gen(function* () {
    const labels = yield* createInternalLabels(id);
    const user = yield* toDisplayName(id, requested, existing);
    return encodeOwnershipLine(labels, user, maxLength);
  });

export const sanitizeFloodlightName = (name: string) =>
  name.replace(/['"]/g, "").slice(0, MAX_FLOODLIGHT_NAME_LENGTH);

export const collectPages = <Page, Item, E extends { _tag: string }, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly Item[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    ignoreList([] as Item[]),
  );

export const listUserProfiles = () =>
  dfa.listUserProfiles({}).pipe(
    Effect.map((page) => page.items ?? []),
    ignoreList([] as dfa.UserProfile[]),
  );

export const listAccessibleProfileIds = Effect.fn(function* () {
  const fromEnv = profileIdFromEnv();
  if (fromEnv) return [fromEnv];
  const profiles = yield* listProfiles();
  return profiles.map((profile) => profile.profileId);
});

export const eachProfile = <A, E, R>(
  fn: (profileId: string) => Effect.Effect<readonly A[], E, R>,
) =>
  listAccessibleProfileIds().pipe(
    Effect.flatMap((ids) =>
      Effect.forEach(ids, fn, { concurrency: 4 }).pipe(
        Effect.map((groups) => groups.flat()),
      ),
    ),
  );

export const listAdvertiserGroups = (profileId: string) =>
  profileId.length === 0
    ? Effect.succeed([] as dfa.AdvertiserGroup[])
    : collectPages(
        dfa.listAdvertiserGroups.pages({ profileId, maxResults: 200 }),
        (page) => page.advertiserGroups,
      );

export const listContentCategories = (profileId: string) =>
  profileId.length === 0
    ? Effect.succeed([] as dfa.ContentCategory[])
    : collectPages(
        dfa.listContentCategories.pages({ profileId, maxResults: 200 }),
        (page) => page.contentCategories,
      );

export const listCreativeFields = (
  profileId: string,
  advertiserIds?: string[],
) =>
  profileId.length === 0
    ? Effect.succeed([] as dfa.CreativeField[])
    : collectPages(
        dfa.listCreativeFields.pages({
          profileId,
          advertiserIds,
          maxResults: 200,
        }),
        (page) => page.creativeFields,
      );

export const listCreativeFieldValues = (
  profileId: string,
  creativeFieldId: string,
) =>
  profileId.length === 0 || creativeFieldId.length === 0
    ? Effect.succeed([] as dfa.CreativeFieldValue[])
    : collectPages(
        dfa.listCreativeFieldValues.pages({
          profileId,
          creativeFieldId,
          maxResults: 200,
        }),
        (page) => page.creativeFieldValues,
      );

export const listEventTags = (profileId: string, advertiserId?: string) =>
  profileId.length === 0
    ? Effect.succeed([] as dfa.EventTag[])
    : dfa
        .listEventTags({
          profileId,
          advertiserId,
        })
        .pipe(
          Effect.map((page) => page.eventTags ?? []),
          ignoreList([] as dfa.EventTag[]),
        );

export const listAdvertisers = (profileId: string) =>
  profileId.length === 0
    ? Effect.succeed([] as dfa.Advertiser[])
    : collectPages(
        dfa.listAdvertisers.pages({ profileId, maxResults: 200 }),
        (page) => page.advertisers,
      );

export const listAdvertiserIds = (profileId: string) =>
  Effect.gen(function* () {
    const fromEnv = advertiserIdFromEnv();
    const advertisers = yield* listAdvertisers(profileId);
    const ids = advertisers
      .map((advertiser) => advertiser.id)
      .filter((id): id is string => !!id);
    if (fromEnv && !ids.includes(fromEnv)) ids.unshift(fromEnv);
    return ids;
  });

export const listFloodlightActivities = (
  profileId: string,
  advertiserId: string,
) =>
  profileId.length === 0 || advertiserId.length === 0
    ? Effect.succeed([] as dfa.FloodlightActivity[])
    : collectPages(
        dfa.listFloodlightActivities.pages({
          profileId,
          advertiserId,
          maxResults: 200,
        }),
        (page) => page.floodlightActivities,
      );

export const listPlacementStrategies = (profileId: string) =>
  profileId.length === 0
    ? Effect.succeed([] as dfa.PlacementStrategy[])
    : collectPages(
        dfa.listPlacementStrategies.pages({ profileId, maxResults: 200 }),
        (page) => page.placementStrategies,
      );

export const listPlacements = (
  profileId: string,
  options?: { searchString?: string; campaignIds?: string[] },
) =>
  profileId.length === 0
    ? Effect.succeed([] as dfa.Placement[])
    : collectPages(
        dfa.listPlacements.pages({
          profileId,
          searchString: options?.searchString,
          campaignIds: options?.campaignIds,
          maxResults: 200,
        }),
        (page) => page.placements,
      );

export const listReports = (profileId: string) =>
  profileId.length === 0
    ? Effect.succeed([] as dfa.Report[])
    : collectPages(
        dfa.listReports.pages({ profileId, maxResults: 200 }),
        (page) => page.items,
      );

export const findByName = <T extends { name?: string }>(
  rows: readonly T[],
  name: string,
) => rows.find((row) => row.name === name);

export const findByValue = <T extends { value?: string }>(
  rows: readonly T[],
  value: string,
) => rows.find((row) => row.value === value);

export const replaceIfChanged = (
  previous: string | undefined,
  next: string | undefined,
  deleteFirst = false,
) => {
  if (previous !== undefined && next !== undefined && previous !== next) {
    return { action: "replace" as const, deleteFirst };
  }
  return undefined;
};
