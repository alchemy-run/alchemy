import * as marketplace from "@distilled.cloud/gcp/authorizedbuyersmarketplace_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const OWNERSHIP_TOKEN = "alc";
export const MAX_LOCAL_PART = 64;
export const PROBE_PARENT = "buyers/1/clients/1";
export const PROBE_NAME = `${PROBE_PARENT}/users/0`;

export type ClientUserState = marketplace.ClientUserStateEnum;

const emptyList = <A>() => Effect.succeed([] as A[]);

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const normalizeResourceName = (value: string) =>
  value.replace(/\/+$/, "").trim();

export const expandBuyer = (value: string) => {
  const trimmed = normalizeResourceName(value);
  if (trimmed.length === 0) return trimmed;
  return trimmed.startsWith("buyers/") ? trimmed : `buyers/${trimmed}`;
};

export const expandParent = (value: string) => {
  const trimmed = normalizeResourceName(value);
  if (trimmed.length === 0) return trimmed;
  if (trimmed.includes("/clients/")) {
    return trimmed.startsWith("buyers/") ? trimmed : `buyers/${trimmed}`;
  }
  return trimmed;
};

export const parentOfName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const usersIndex = parts.lastIndexOf("users");
  if (usersIndex > 0) return parts.slice(0, usersIndex).join("/");
  const clientUsersIndex = parts.lastIndexOf("clientUsers");
  if (clientUsersIndex > 0) return parts.slice(0, clientUsersIndex).join("/");
  return "";
};

export const resourceName = (parent: string, userId: string) =>
  `${expandParent(parent)}/users/${userId}`;

export const userIdOf = (name: string) => lastSegment(name);

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const normalizeEmail = (email: string | undefined) =>
  (email ?? "").trim().toLowerCase();

export const replaceOnIdentity = (input: {
  previousParent?: string;
  nextParent: string;
  previousEmail?: string;
  nextEmail?: string;
  previousUserId?: string;
  nextUserId?: string;
}) => {
  if (
    input.previousParent !== undefined &&
    input.previousParent.length > 0 &&
    input.previousParent !== input.nextParent
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousEmail !== undefined &&
    input.nextEmail !== undefined &&
    normalizeEmail(input.previousEmail) !== normalizeEmail(input.nextEmail)
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousUserId !== undefined &&
    input.nextUserId !== undefined &&
    input.previousUserId !== input.nextUserId
  ) {
    return { action: "replace" as const, deleteFirst: true };
  }
  return undefined;
};

const markerOf = (stack: string, stage: string, id: string) =>
  `${OWNERSHIP_TOKEN}.${stack}.${stage}.${id}`;

const fitMarker = (labels: Record<string, string>, maxLength: number) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerOf(stack, stage, id);
  while (
    marker.length > maxLength &&
    (stack.length > 1 || stage.length > 1 || id.length > 1)
  ) {
    if (id.length >= stack.length && id.length >= stage.length) {
      id = id.slice(0, -1);
    } else if (stack.length >= stage.length) {
      stack = stack.slice(0, -1);
    } else {
      stage = stage.slice(0, -1);
    }
    marker = markerOf(stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

const splitEmail = (email: string) => {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return { local: trimmed, domain: "" };
  return { local: trimmed.slice(0, at), domain: trimmed.slice(at + 1) };
};

const stripOwnershipLocal = (local: string) => {
  const token = `+${OWNERSHIP_TOKEN}.`;
  const index = local.lastIndexOf(token);
  return index >= 0 ? local.slice(0, index) : local;
};

/**
 * Client users have no labels or description, so Alchemy stamps
 * ownership into the email local-part as `+alc.{stack}.{stage}.{id}`.
 */
export const encodeEmail = (
  labels: Record<string, string>,
  email: string,
): string => {
  const { local, domain } = splitEmail(email);
  if (domain.length === 0) return email.trim();
  const base = stripOwnershipLocal(local);
  const reserved = base.length + 1;
  const marker = fitMarker(labels, Math.max(8, MAX_LOCAL_PART - reserved));
  const next = `${base}+${marker}`.slice(0, MAX_LOCAL_PART);
  return `${next}@${domain}`;
};

export const parseEmail = (
  email: string | undefined,
): {
  labels: Record<string, string>;
  email: string | undefined;
} => {
  if (!email) return { labels: {}, email };
  const { local, domain } = splitEmail(email);
  const token = `+${OWNERSHIP_TOKEN}.`;
  const index = local.lastIndexOf(token);
  if (index < 0) return { labels: {}, email };
  const tag = local.slice(index + token.length);
  const [stack, stage, ...idParts] = tag.split(".");
  const base = local.slice(0, index);
  const restored =
    domain.length > 0 ? `${base}@${domain}` : base.length > 0 ? base : email;
  return {
    labels: {
      [alchemyLabelKeys.stack]: stack ?? "",
      [alchemyLabelKeys.stage]: stage ?? "",
      [alchemyLabelKeys.id]: idParts.join("."),
    },
    email: restored,
  };
};

export const hasOwnershipMarker = (email: string | undefined) =>
  Object.keys(parseEmail(email).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (id: string, email: string | undefined) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const { labels } = parseEmail(email);
    if (!hasOwnershipMarker(email)) return false;
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

export const toEmail = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) return requested;
    if (existing !== undefined && existing.length > 0) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: 32,
      lowercase: true,
    });
    const local = generated.replace(/[^a-z0-9]/g, "").slice(0, 32) || "alchemy";
    return `${local}@example.com`;
  });

export type ClientUserAttrs = {
  name: string;
  userId: string;
  parent: string;
  project: string;
  email: string;
  state: string | undefined;
};

export const toAttrs = (
  user: marketplace.ClientUser,
  parent: string,
  project: string,
): ClientUserAttrs => {
  const name = user.name ?? "";
  const parsed = parseEmail(user.email);
  return {
    name,
    userId: userIdOf(name),
    parent: parentOfName(name) || parent,
    project,
    email: parsed.email ?? user.email ?? "",
    state: user.state,
  };
};

export const findOwnedUser = (
  users: readonly marketplace.ClientUser[],
  id: string,
  name?: string,
  email?: string,
) =>
  Effect.gen(function* () {
    if (name) {
      const exact = users.find((user) => user.name === name);
      if (exact !== undefined) return exact;
    }
    const desired = email
      ? normalizeEmail(parseEmail(email).email ?? email)
      : undefined;
    let owned: marketplace.ClientUser | undefined;
    for (const user of users) {
      if (!(yield* ownedByAlchemy(id, user.email))) continue;
      const observed = normalizeEmail(
        parseEmail(user.email).email ?? user.email ?? "",
      );
      if (desired !== undefined) {
        if (observed === desired) return user;
        continue;
      }
      if (owned === undefined) owned = user;
    }
    return desired !== undefined ? undefined : owned;
  });

const isMissing = <E extends { readonly _tag: string }>(
  error: E,
): error is Extract<E, { readonly _tag: "NotFound" | "Forbidden" }> =>
  error._tag === "NotFound" || error._tag === "Forbidden";

const ignoreList =
  <A>(fallback: A) =>
  <A1, E extends { readonly _tag: string }, R>(
    self: Effect.Effect<A1, E, R>,
  ): Effect.Effect<A1 | A, E, R> =>
    self.pipe(Effect.catchIf(isMissing, () => Effect.succeed(fallback)));

export const collectPages = <A, Page, E, R>(
  pages: Stream.Stream<Page, E, R>,
  pick: (page: Page) => readonly A[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(pick(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

export const listUsers = (parent: string) =>
  parent.length === 0
    ? emptyList<marketplace.ClientUser>()
    : collectPages(
        marketplace.listBuyersClientsUsers.pages({
          parent,
          pageSize: 200,
        }),
        (page) => page.clientUsers,
      ).pipe(ignoreList([] as marketplace.ClientUser[]));

export const listClients = (buyer: string) =>
  buyer.length === 0
    ? emptyList<marketplace.Client>()
    : collectPages(
        marketplace.listBuyersClients.pages({
          parent: buyer,
          pageSize: 200,
        }),
        (page) => page.clients,
      ).pipe(ignoreList([] as marketplace.Client[]));

const ownersFromEnv = (
  keys: readonly string[],
  expand: (value: string) => string,
) => {
  const values: string[] = [];
  for (const key of keys) {
    const raw = process.env[key]?.trim();
    if (!raw) continue;
    for (const part of raw.split(/[,\s]+/)) {
      if (part.length > 0) values.push(expand(part));
    }
  }
  return [...new Set(values)];
};

export const buyersFromEnv = () =>
  ownersFromEnv(
    [
      "GCP_AUTHORIZEDBUYERSMARKETPLACE_BUYER_ID",
      "GCP_AUTHORIZEDBUYERSMARKETPLACE_BUYER_IDS",
    ],
    expandBuyer,
  );

export const parentsFromEnv = () => {
  const explicit = ownersFromEnv(
    [
      "GCP_AUTHORIZEDBUYERSMARKETPLACE_PARENT",
      "GCP_AUTHORIZEDBUYERSMARKETPLACE_PARENTS",
    ],
    expandParent,
  );
  const buyer = process.env.GCP_AUTHORIZEDBUYERSMARKETPLACE_BUYER_ID?.trim();
  const client = process.env.GCP_AUTHORIZEDBUYERSMARKETPLACE_CLIENT_ID?.trim();
  if (buyer && client) {
    const parent = expandParent(
      client.includes("/clients/")
        ? client
        : `${expandBuyer(buyer)}/clients/${lastSegment(client)}`,
    );
    explicit.push(parent);
  }
  return [...new Set(explicit)];
};

export const listParentsForNuke = () =>
  Effect.gen(function* () {
    const parents = parentsFromEnv();
    if (parents.length > 0) return parents;
    const buyers = buyersFromEnv();
    const nested = yield* Effect.forEach(
      buyers,
      (buyer) =>
        listClients(buyer).pipe(
          Effect.map((clients) =>
            clients
              .map((client) => client.name)
              .filter((name): name is string => !!name),
          ),
        ),
      { concurrency: 4 },
    );
    return [...new Set(nested.flat())];
  });
