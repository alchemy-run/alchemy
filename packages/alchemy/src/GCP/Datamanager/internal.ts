import * as datamanager from "@distilled.cloud/gcp/datamanager_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const DEFAULT_ACCOUNT_TYPE = "GOOGLE_ADS";
export const DEFAULT_MEMBERSHIP_STATUS = "OPEN";
export const DEFAULT_UPLOAD_KEY_TYPES: datamanager.IngestedUserListInfoUploadKeyTypesItemEnumList =
  ["CONTACT_ID"];
export const PROBE_PARENT = "accountTypes/GOOGLE_ADS/accounts/0";
export const PROBE_NAME = `${PROBE_PARENT}/userLists/0`;

export type AccountType =
  | datamanager.ProductAccountAccountTypeEnum
  | (string & {});

export type MembershipStatus =
  | datamanager.UserListMembershipStatusEnum
  | (string & {});

export type AccountAccessStatus =
  | datamanager.UserListAccountAccessStatusEnum
  | (string & {});

export type UploadKeyType =
  | datamanager.IngestedUserListInfoUploadKeyTypesItemEnum
  | (string & {});

export type TargetNetworkInfoProps = {
  /** Whether the list is eligible for the Google Display Network. */
  eligibleForDisplay?: boolean;
  /** Whether the list is eligible for Google Search. */
  eligibleForSearch?: boolean;
};

export type PartnerAudienceInfoProps = {
  /** Immutable source of the partner audience. */
  partnerAudienceSource?:
    | datamanager.PartnerAudienceInfoPartnerAudienceSourceEnum
    | (string & {});
  /** Commerce partner name. Only for `COMMERCE_AUDIENCE`. */
  commercePartner?: string;
};

export type MobileIdInfoProps = {
  /** Immutable mobile ID key space (`IOS` or `ANDROID`). */
  keySpace?: datamanager.MobileIdInfoKeySpaceEnum | (string & {});
  /** Immutable app id the mobile IDs were collected from. */
  appId?: string;
  /** Immutable source of the upload data. */
  dataSourceType?: datamanager.MobileIdInfoDataSourceTypeEnum | (string & {});
};

export type PairIdInfoProps = {
  /** Immutable publisher id in the clean room. */
  publisherId?: string;
  /** Membership match percentage (0-100). */
  matchRatePercentage?: number;
  /** Publisher display name. */
  publisherName?: string;
  /** Count of advertiser first-party records uploaded. */
  advertiserIdentifierCount?: string;
  /** Immutable advertiser-to-publisher clean room identifier. */
  cleanRoomIdentifier?: string;
};

export type ContactIdInfoProps = {
  /** Immutable source of the upload data. */
  dataSourceType?: datamanager.ContactIdInfoDataSourceTypeEnum | (string & {});
};

export type UserIdInfoProps = {
  /** Immutable source of the upload data. */
  dataSourceType?: datamanager.UserIdInfoDataSourceTypeEnum | (string & {});
};

export type IngestedUserListInfoProps = {
  /**
   * Immutable upload key types (`CONTACT_ID`, `MOBILE_ID`, `USER_ID`,
   * `PAIR_ID`, `PSEUDONYMOUS_ID`).
   * @default ["CONTACT_ID"]
   */
  uploadKeyTypes?: UploadKeyType[];
  /** Partner-audience metadata. Data partners only. */
  partnerAudienceInfo?: PartnerAudienceInfoProps;
  /** Extra fields when `MOBILE_ID` is an upload key type. */
  mobileIdInfo?: MobileIdInfoProps;
  /** Extra fields when `PAIR_ID` is an upload key type. Data partners only. */
  pairIdInfo?: PairIdInfoProps;
  /** Extra fields when `CONTACT_ID` is an upload key type. */
  contactIdInfo?: ContactIdInfoProps;
  /** Extra fields when `USER_ID` is an upload key type. */
  userIdInfo?: UserIdInfoProps;
};

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const normalizeResourceName = (value: string) =>
  value.replace(/\/+$/, "").trim();

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const accountIdOf = (value: string) =>
  lastSegment(value).replace(/-/g, "");

export const parentOf = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const index = parts.lastIndexOf("userLists");
  if (index <= 0) return "";
  return parts.slice(0, index).join("/");
};

export const accountTypeOf = (parent: string) => {
  const parts = parent.split("/").filter((part) => part.length > 0);
  const index = parts.indexOf("accountTypes");
  if (index < 0 || parts[index + 1] === undefined) return DEFAULT_ACCOUNT_TYPE;
  return parts[index + 1]!;
};

export const accountOf = (parent: string) => {
  const parts = parent.split("/").filter((part) => part.length > 0);
  const index = parts.indexOf("accounts");
  if (index < 0 || parts[index + 1] === undefined) return "";
  return parts[index + 1]!;
};

export const resourceName = (parent: string, userListId: string) =>
  `${normalizeResourceName(parent)}/userLists/${userListId}`;

export const parentName = (accountType: string, account: string) => {
  const trimmed = normalizeResourceName(account);
  if (trimmed.includes("/accounts/")) return trimmed;
  return `accountTypes/${accountType}/accounts/${accountIdOf(trimmed)}`;
};

export const resolveParent = (input: {
  parent?: string;
  accountType?: string;
  account?: string;
}) => {
  if (input.parent && input.parent.length > 0) {
    return normalizeResourceName(input.parent);
  }
  if (input.account && input.account.length > 0) {
    return parentName(input.accountType ?? DEFAULT_ACCOUNT_TYPE, input.account);
  }
  return "";
};

export const replaceOnIdentity = (input: {
  previousParent?: string;
  nextParent: string;
  previousId?: string;
  nextId?: string;
  previousIngested?: unknown;
  nextIngested?: unknown;
}) => {
  if (
    input.previousParent !== undefined &&
    input.previousParent.length > 0 &&
    input.nextParent.length > 0 &&
    input.previousParent !== input.nextParent
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
  if (
    input.nextIngested !== undefined &&
    input.previousIngested !== undefined &&
    !jsonEqual(input.previousIngested, input.nextIngested)
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  return undefined;
};

const markerOf = (stack: string, stage: string, id: string) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

export const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = markerOf(
    labels[alchemyLabelKeys.stack] ?? "x",
    labels[alchemyLabelKeys.stage] ?? "x",
    labels[alchemyLabelKeys.id] ?? "x",
  );
  return description && description.length > 0
    ? `${marker}\n${description}`
    : marker;
};

export const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (id: string, description: string | undefined) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const { labels } = parseDescription(description);
    if (!hasOwnershipMarker(description)) return false;
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

export const toDisplayName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) return requested;
    if (existing !== undefined && existing.length > 0) return existing;
    return yield* createPhysicalName({
      id,
      maxLength: 63,
      lowercase: true,
    });
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
    datamanager.DeleteAccountTypesAccountsUserListsError,
    R
  >,
) =>
  effect.pipe(
    Effect.catchTag("NotFound", () => Effect.void),
    Effect.catchTag("Forbidden", () => Effect.void),
  );

export const getUserList = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : datamanager.getAccountTypesAccountsUserLists({ name }).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
      );

export const listUserLists = (parent: string) =>
  parent.length === 0
    ? emptyList<datamanager.UserList>()
    : collectPages(
        datamanager.listAccountTypesAccountsUserLists.pages({
          parent,
          pageSize: 200,
        }),
        (page) => page.userLists,
      ).pipe(
        Effect.catchTag("NotFound", () => emptyList<datamanager.UserList>()),
        Effect.catchTag("Forbidden", () => emptyList<datamanager.UserList>()),
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

export const parentsFromEnv = () => {
  const names = new Set<string>();
  for (const parent of valuesFromEnv([
    "GCP_DATAMANAGER_PARENT",
    "GCP_TEST_DATAMANAGER_PARENT",
  ])) {
    names.add(normalizeResourceName(parent));
  }
  const accountType =
    process.env.GCP_DATAMANAGER_ACCOUNT_TYPE?.trim() || DEFAULT_ACCOUNT_TYPE;
  for (const account of valuesFromEnv([
    "GCP_DATAMANAGER_ACCOUNT",
    "GCP_GOOGLE_ADS_ACCOUNT",
    "GCP_GOOGLE_ADS_CUSTOMER_ID",
  ])) {
    names.add(parentName(accountType, account));
  }
  return [...names];
};

export const listOwnedUserLists = () =>
  Effect.gen(function* () {
    const parents = yield* Effect.sync(() => parentsFromEnv());
    const pages = yield* Effect.forEach(
      parents,
      (parent) => listUserLists(parent),
      { concurrency: 4 },
    );
    return pages.flat().filter((row) => hasOwnershipMarker(row.description));
  });

export const findOwnedUserList = (id: string, parent?: string) =>
  Effect.gen(function* () {
    const rows =
      parent && parent.length > 0
        ? yield* listUserLists(parent)
        : yield* listOwnedUserLists();
    for (const row of rows) {
      if (yield* ownedByAlchemy(id, row.description)) {
        return row;
      }
    }
    return undefined;
  });

export const findUserListByDisplayName = (
  displayName: string,
  parent?: string,
) =>
  Effect.gen(function* () {
    const rows =
      parent && parent.length > 0
        ? yield* listUserLists(parent)
        : yield* listOwnedUserLists();
    return rows.find((row) => row.displayName === displayName);
  });

export const ingestedIdentity = (
  info: IngestedUserListInfoProps | undefined,
) => {
  if (info === undefined) return undefined;
  return {
    uploadKeyTypes: [...(info.uploadKeyTypes ?? [])].slice().sort(),
    partnerAudienceInfo: info.partnerAudienceInfo
      ? {
          partnerAudienceSource: info.partnerAudienceInfo.partnerAudienceSource,
          commercePartner: info.partnerAudienceInfo.commercePartner,
        }
      : undefined,
    mobileIdInfo: info.mobileIdInfo
      ? {
          keySpace: info.mobileIdInfo.keySpace,
          appId: info.mobileIdInfo.appId,
          dataSourceType: info.mobileIdInfo.dataSourceType,
        }
      : undefined,
    pairIdInfo: info.pairIdInfo
      ? {
          publisherId: info.pairIdInfo.publisherId,
          publisherName: info.pairIdInfo.publisherName,
          matchRatePercentage: info.pairIdInfo.matchRatePercentage,
          advertiserIdentifierCount: info.pairIdInfo.advertiserIdentifierCount,
          cleanRoomIdentifier: info.pairIdInfo.cleanRoomIdentifier,
        }
      : undefined,
    contactIdInfo: info.contactIdInfo
      ? { dataSourceType: info.contactIdInfo.dataSourceType }
      : undefined,
    userIdInfo: info.userIdInfo
      ? { dataSourceType: info.userIdInfo.dataSourceType }
      : undefined,
  };
};

export const ingestedFromRow = (
  info: datamanager.IngestedUserListInfo | undefined,
): IngestedUserListInfoProps | undefined => {
  if (info === undefined) return undefined;
  return {
    uploadKeyTypes: info.uploadKeyTypes,
    partnerAudienceInfo: info.partnerAudienceInfo
      ? {
          partnerAudienceSource: info.partnerAudienceInfo.partnerAudienceSource,
          commercePartner: info.partnerAudienceInfo.commercePartner,
        }
      : undefined,
    mobileIdInfo: info.mobileIdInfo
      ? {
          keySpace: info.mobileIdInfo.keySpace,
          appId: info.mobileIdInfo.appId,
          dataSourceType: info.mobileIdInfo.dataSourceType,
        }
      : undefined,
    pairIdInfo: info.pairIdInfo
      ? {
          publisherId: info.pairIdInfo.publisherId,
          matchRatePercentage: info.pairIdInfo.matchRatePercentage,
          publisherName: info.pairIdInfo.publisherName,
          advertiserIdentifierCount: info.pairIdInfo.advertiserIdentifierCount,
          cleanRoomIdentifier: info.pairIdInfo.cleanRoomIdentifier,
        }
      : undefined,
    contactIdInfo: info.contactIdInfo
      ? { dataSourceType: info.contactIdInfo.dataSourceType }
      : undefined,
    userIdInfo: info.userIdInfo
      ? { dataSourceType: info.userIdInfo.dataSourceType }
      : undefined,
  };
};

export const toIngestedBody = (
  info: IngestedUserListInfoProps | undefined,
): datamanager.IngestedUserListInfo => ({
  uploadKeyTypes: info?.uploadKeyTypes ?? DEFAULT_UPLOAD_KEY_TYPES,
  partnerAudienceInfo: info?.partnerAudienceInfo,
  mobileIdInfo: info?.mobileIdInfo,
  pairIdInfo: info?.pairIdInfo,
  contactIdInfo: info?.contactIdInfo,
  userIdInfo: info?.userIdInfo,
});
