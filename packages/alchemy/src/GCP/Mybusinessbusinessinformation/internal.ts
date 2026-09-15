import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const MAX_TITLE = 300;
export const DEFAULT_ACCOUNT = "accounts/-";
export const READ_MASK =
  "name,title,languageCode,storeCode,storefrontAddress,labels,websiteUri,phoneNumbers,metadata";

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const accountParent = (account: string | undefined) => {
  if (!account || account.length === 0) return DEFAULT_ACCOUNT;
  return account.startsWith("accounts/") ? account : `accounts/${account}`;
};

const markerOf = (labels: Record<string, string>) =>
  `alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}`;

export const ownershipLabelsList = (
  labels: Record<string, string>,
): string[] => [
  `${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]}`,
  `${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]}`,
  `${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}`,
];

export const parseOwnershipLabels = (
  labels: readonly string[] | undefined,
): Record<string, string> => {
  const parsed: Record<string, string> = {};
  for (const label of labels ?? []) {
    if (!label.startsWith("alchemy-")) continue;
    const eq = label.indexOf("=");
    if (eq > 0) parsed[label.slice(0, eq)] = label.slice(eq + 1);
  }
  return parsed;
};

export const hasOwnershipMarker = (labels: readonly string[] | undefined) =>
  Object.keys(parseOwnershipLabels(labels)).some((key) =>
    key.startsWith("alchemy-"),
  );

export const ownedByAlchemy = (
  id: string,
  labels: readonly string[] | undefined,
) => hasAlchemyLabels(id, parseOwnershipLabels(labels));

export const userLabels = (labels: readonly string[] | undefined): string[] =>
  (labels ?? []).filter((label) => !label.startsWith("alchemy-"));

export const mergeLabels = (
  ownership: Record<string, string>,
  user: readonly string[] | undefined,
): string[] => [...ownershipLabelsList(ownership), ...userLabels(user)];

export const ownedTitle = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined) return requested.slice(0, MAX_TITLE);
    if (existing !== undefined) return existing.slice(0, MAX_TITLE);
    const generated = yield* createPhysicalName({
      id,
      maxLength: 40,
      lowercase: true,
    });
    return generated.slice(0, MAX_TITLE);
  });

export { alchemyLabelKeys, markerOf, createInternalLabels };
