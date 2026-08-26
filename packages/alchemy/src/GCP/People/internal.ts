import * as people from "@distilled.cloud/gcp/people_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const GROUP_FIELDS = "clientData,groupType,memberCount,metadata,name";
export const PERSON_FIELDS =
  "names,emailAddresses,phoneNumbers,clientData,memberships,metadata,biographies,nicknames,userDefined";
export const MAX_GROUP_NAME_LENGTH = 255;
export const MY_CONTACTS = "contactGroups/myContacts";

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
  maxLength = MAX_GROUP_NAME_LENGTH,
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

export const hasOwnershipMarker = (text: string | undefined) => {
  if (
    Object.keys(parseOwnership(text).labels).some((key) =>
      key.startsWith("alchemy-"),
    )
  ) {
    return true;
  }
  return (text ?? "").toLowerCase().includes("alchemy-");
};

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByText = (id: string, text: string | undefined) =>
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

export const labelsFromClientData = (
  data: ReadonlyArray<{ key?: string; value?: string }> | null | undefined,
): Record<string, string> => {
  const labels: Record<string, string> = {};
  for (const item of data ?? []) {
    if (item.key !== undefined && item.key.length > 0) {
      labels[item.key] = item.value ?? "";
    }
  }
  return labels;
};

export const hasAlchemyClientData = (
  data: ReadonlyArray<{ key?: string; value?: string }> | null | undefined,
) =>
  Object.keys(labelsFromClientData(data)).some((key) =>
    key.startsWith("alchemy-"),
  );

export const ownedByClientData = (
  id: string,
  data: ReadonlyArray<{ key?: string; value?: string }> | null | undefined,
) =>
  Effect.gen(function* () {
    const labels = labelsFromClientData(data);
    if (!Object.keys(labels).some((key) => key.startsWith("alchemy-"))) {
      return false;
    }
    const exact = yield* hasAlchemyLabels(id, labels);
    if (exact) return true;
    const expected = yield* createInternalLabels(id);
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

export const mergeOwnershipClientData = (
  userData: ReadonlyArray<{ key?: string; value?: string }> | undefined,
  ownership: Record<string, string>,
): Array<{ key: string; value: string }> => {
  const owned = Object.entries(ownership).map(([key, value]) => ({
    key,
    value,
  }));
  const user = (userData ?? [])
    .filter(
      (item) => item.key === undefined || !item.key.startsWith("alchemy-"),
    )
    .map((item) => ({
      key: item.key ?? "",
      value: item.value ?? "",
    }))
    .filter((item) => item.key.length > 0);
  return [...owned, ...user];
};

export const userClientData = (
  data: ReadonlyArray<{ key?: string; value?: string }> | undefined,
): Array<{ key: string; value: string }> =>
  (data ?? [])
    .filter(
      (item): item is { key: string; value?: string } =>
        item.key !== undefined &&
        item.key.length > 0 &&
        !item.key.startsWith("alchemy-"),
    )
    .map((item) => ({ key: item.key, value: item.value ?? "" }));

export const groupOwnedByAlchemy = (id: string, group: people.ContactGroup) =>
  Effect.gen(function* () {
    if (yield* ownedByClientData(id, group.clientData)) return true;
    return yield* ownedByText(id, group.name);
  });

export const personOwnedByAlchemy = (id: string, person: people.Person) =>
  ownedByClientData(id, person.clientData);

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const toGeneratedName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = 40,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return requested;
    }
    if (existing !== undefined && existing.length > 0) {
      return existing;
    }
    const generated = yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
    });
    const next = /^[a-z]/.test(generated)
      ? generated
      : `p${generated}`.slice(0, maxLength);
    return next.length >= 4 ? next : `${next}xxxx`.slice(0, maxLength);
  });

const emptyList = <A>() => Effect.succeed([] as A[]);

export const catchMissing = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (
        error,
      ): error is E & {
        readonly _tag: "NotFound" | "Forbidden" | "Unauthorized";
      } =>
        error._tag === "NotFound" ||
        error._tag === "Forbidden" ||
        error._tag === "Unauthorized",
      () => Effect.succeed(undefined),
    ),
  );

export const ignoreMissing = <E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<unknown, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (
        error,
      ): error is E & {
        readonly _tag: "NotFound" | "Forbidden" | "Unauthorized";
      } =>
        error._tag === "NotFound" ||
        error._tag === "Forbidden" ||
        error._tag === "Unauthorized",
      () => Effect.void,
    ),
  );

export const getContactGroup = (resourceName: string) =>
  resourceName.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        people.getContactGroups({
          resourceName,
          groupFields: GROUP_FIELDS,
        }),
      );

export const listContactGroups = () =>
  people.listContactGroups
    .pages({
      pageSize: 1000,
      groupFields: GROUP_FIELDS,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.contactGroups ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => emptyList<people.ContactGroup>()),
      Effect.catchTag("Forbidden", () => emptyList<people.ContactGroup>()),
      Effect.catchTag("Unauthorized", () => emptyList<people.ContactGroup>()),
    );

export const listOwnedContactGroups = () =>
  listContactGroups().pipe(
    Effect.map((items) =>
      items.filter(
        (item) =>
          hasOwnershipMarker(item.name) ||
          hasAlchemyClientData(item.clientData),
      ),
    ),
  );

export const findOwnedContactGroup = (id: string, name?: string) =>
  Effect.gen(function* () {
    const items = yield* listContactGroups();
    if (name !== undefined && name.length > 0) {
      const byName = items.find((item) => item.name === name);
      if (byName !== undefined) return byName;
    }
    for (const item of items) {
      if (yield* groupOwnedByAlchemy(id, item)) {
        return item;
      }
    }
    return undefined;
  });

export const getContactPerson = (resourceName: string) =>
  resourceName.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        people.getPeople({
          resourceName,
          personFields: PERSON_FIELDS,
          sources: ["READ_SOURCE_TYPE_CONTACT"],
        }),
      );

export const listContactPeople = () =>
  people.listPeopleConnections
    .pages({
      resourceName: "people/me",
      pageSize: 1000,
      personFields: PERSON_FIELDS,
      sources: ["READ_SOURCE_TYPE_CONTACT"],
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.connections ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => emptyList<people.Person>()),
      Effect.catchTag("Forbidden", () => emptyList<people.Person>()),
      Effect.catchTag("Unauthorized", () => emptyList<people.Person>()),
    );

export const listOwnedContactPeople = () =>
  listContactPeople().pipe(
    Effect.map((items) =>
      items.filter((item) => hasAlchemyClientData(item.clientData)),
    ),
  );

export const findOwnedContactPerson = (id: string) =>
  Effect.gen(function* () {
    const items = yield* listContactPeople();
    for (const item of items) {
      if (yield* personOwnedByAlchemy(id, item)) {
        return item;
      }
    }
    return undefined;
  });

export const emailsOf = (emails: people.EmailAddressList | undefined) =>
  (emails ?? []).map((email) => ({
    value: email.value ?? "",
    type: email.type,
    displayName: email.displayName,
  }));

export const phonesOf = (phones: people.PhoneNumberList | undefined) =>
  (phones ?? []).map((phone) => ({
    value: phone.value ?? "",
    type: phone.type,
  }));

export const membershipsOf = (memberships: people.MembershipList | undefined) =>
  (memberships ?? [])
    .map((item) => item.contactGroupMembership?.contactGroupResourceName ?? "")
    .filter((name) => name.length > 0)
    .slice()
    .sort();

export const nameOf = (names: people.NameList | undefined) => {
  const name = names?.[0];
  if (name === undefined) return undefined;
  return {
    givenName: name.givenName,
    familyName: name.familyName,
    middleName: name.middleName,
    honorificPrefix: name.honorificPrefix,
    honorificSuffix: name.honorificSuffix,
    unstructuredName: name.unstructuredName,
  };
};

export const biographyOf = (biographies: people.BiographyList | undefined) =>
  biographies?.[0]?.value;

export const toMemberships = (
  resourceNames: readonly string[] | undefined,
): people.MembershipList | undefined => {
  if (resourceNames === undefined) return undefined;
  const names = resourceNames.length > 0 ? [...resourceNames] : [MY_CONTACTS];
  return names.map((contactGroupResourceName) => ({
    contactGroupMembership: { contactGroupResourceName },
  }));
};
