import * as adsense from "@distilled.cloud/gcp/adsense_v2";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const MAX_DISPLAY_NAME_LENGTH = 80;
export const PROBE_PARENT =
  "accounts/pub-0000000000000000/adclients/ca-pub-0000000000000000";
export const PROBE_NAME = `${PROBE_PARENT}/customchannels/alchemy-missing`;

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const parentOf = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  if (parts.length < 2) return "";
  return parts.slice(0, -2).join("/");
};

export const normalizeResourceName = (value: string) =>
  value.replace(/\/+$/, "").trim();

export const toAccountName = (value: string) => {
  const trimmed = normalizeResourceName(value);
  if (trimmed.length === 0) return trimmed;
  return trimmed.startsWith("accounts/") ? trimmed : `accounts/${trimmed}`;
};

export const toAdClientName = (account: string, adClient: string) => {
  const trimmed = normalizeResourceName(adClient);
  if (trimmed.includes("/adclients/")) return trimmed;
  const accountName = toAccountName(account);
  const id = trimmed.startsWith("adclients/") ? lastSegment(trimmed) : trimmed;
  return `${accountName}/adclients/${id}`;
};

export const resourceName = (parent: string, customChannelId: string) =>
  `${normalizeResourceName(parent)}/customchannels/${customChannelId}`;

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameBoolean = (
  left: boolean | undefined,
  right: boolean | undefined,
) => left === right;

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const replaceOnIdentity = (input: {
  previousParent?: string;
  nextParent: string;
  previousId?: string;
  nextId?: string;
}) => {
  if (
    input.previousParent !== undefined &&
    input.previousParent.length > 0 &&
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
  return undefined;
};

const markerOf = (stack: string, stage: string, id: string) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const fitMarker = (labels: Record<string, string>, maxLength: number) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerOf(stack, stage, id);
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
    marker = markerOf(stack, stage, id);
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
      maxLength: 40,
      lowercase: true,
    });
  });

const emptyList = <A>() => Effect.succeed([] as A[]);

type AdsenseOpError =
  | adsense.NotFound
  | adsense.Forbidden
  | adsense.BadRequest
  | adsense.Conflict
  | adsense.GcpOpError;

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
  effect: Effect.Effect<A, AdsenseOpError, R>,
) =>
  effect.pipe(
    Effect.catchTag("NotFound", () => Effect.void),
    Effect.catchTag("Forbidden", () => Effect.void),
  );

export const getCustomChannel = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : adsense.getAccountsAdclientsCustomchannels({ name }).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
      );

export const listAccounts = () =>
  collectPages(
    adsense.listAccounts.pages({ pageSize: 200 }),
    (page) => page.accounts,
  ).pipe(
    Effect.catchTag("NotFound", () => emptyList<adsense.Account>()),
    Effect.catchTag("Forbidden", () => emptyList<adsense.Account>()),
  );

export const listAdClients = (parent: string) =>
  parent.length === 0
    ? emptyList<adsense.AdClient>()
    : collectPages(
        adsense.listAccountsAdclients.pages({ parent, pageSize: 200 }),
        (page) => page.adClients,
      ).pipe(
        Effect.catchTag("NotFound", () => emptyList<adsense.AdClient>()),
        Effect.catchTag("Forbidden", () => emptyList<adsense.AdClient>()),
      );

export const listCustomChannels = (parent: string) =>
  parent.length === 0
    ? emptyList<adsense.CustomChannel>()
    : collectPages(
        adsense.listAccountsAdclientsCustomchannels.pages({
          parent,
          pageSize: 200,
        }),
        (page) => page.customChannels,
      ).pipe(
        Effect.catchTag("NotFound", () => emptyList<adsense.CustomChannel>()),
        Effect.catchTag("Forbidden", () => emptyList<adsense.CustomChannel>()),
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
    "GCP_ADSENSE_PARENT",
    "GCP_ADSENSE_ADCLIENT",
    "GCP_ADSENSE_ADCLIENT_ID",
  ])) {
    if (parent.includes("/adclients/")) {
      names.add(normalizeResourceName(parent));
    }
  }
  const accounts = valuesFromEnv([
    "GCP_ADSENSE_ACCOUNT",
    "GCP_ADSENSE_ACCOUNT_ID",
  ]);
  const adClients = valuesFromEnv([
    "GCP_ADSENSE_ADCLIENT",
    "GCP_ADSENSE_ADCLIENT_ID",
  ]).filter((value) => !value.includes("/adclients/"));
  for (const account of accounts) {
    for (const adClient of adClients) {
      names.add(toAdClientName(account, adClient));
    }
  }
  return [...names];
};

export const listParents = () =>
  Effect.gen(function* () {
    const names = new Set(parentsFromEnv());
    const accounts = yield* listAccounts();
    const pages = yield* Effect.forEach(
      accounts,
      (account) =>
        account.name
          ? listAdClients(account.name)
          : emptyList<adsense.AdClient>(),
      { concurrency: 4 },
    );
    for (const clients of pages) {
      for (const client of clients) {
        if (client.name) names.add(client.name);
      }
    }
    return [...names];
  });

export const listAllCustomChannels = () =>
  Effect.gen(function* () {
    const parents = yield* listParents();
    const pages = yield* Effect.forEach(
      parents,
      (parent) => listCustomChannels(parent),
      { concurrency: 4 },
    );
    return pages.flat();
  });

export const listOwnedCustomChannels = () =>
  listAllCustomChannels().pipe(
    Effect.map((channels) =>
      channels.filter((channel) => hasOwnershipMarker(channel.displayName)),
    ),
  );

export const findOwnedCustomChannel = (id: string, parent?: string) =>
  Effect.gen(function* () {
    const rows =
      parent && parent.length > 0
        ? yield* listCustomChannels(parent)
        : yield* listAllCustomChannels();
    for (const row of rows) {
      if (yield* ownedByAlchemy(id, row.displayName)) {
        return row;
      }
    }
    return undefined;
  });

export const findCustomChannelByDisplayName = (
  displayName: string,
  parent?: string,
) =>
  Effect.gen(function* () {
    const rows =
      parent && parent.length > 0
        ? yield* listCustomChannels(parent)
        : yield* listAllCustomChannels();
    return rows.find((row) => row.displayName === displayName);
  });
