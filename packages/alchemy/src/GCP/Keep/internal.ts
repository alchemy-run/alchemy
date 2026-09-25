import * as keep from "@distilled.cloud/gcp/keep_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const MAX_TITLE_LENGTH = 1000;
export const MAX_TEXT_LENGTH = 20_000;
export const LIST_FILTER = "trashed=false";

export type ListItemProps = {
  /** Item text (max 1,000 characters). */
  text: string;
  /** Whether this item is checked off. */
  checked?: boolean;
  /** One level of nested items. */
  childListItems?: ListItemProps[];
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

export const encodeOwnershipLine = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_TITLE_LENGTH,
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

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const noteNameOf = (name: string | undefined) => {
  if (!name || name.length === 0) return "";
  return name.startsWith("notes/") ? name : `notes/${name}`;
};

export const noteIdOf = (name: string | undefined) => {
  const full = noteNameOf(name);
  return full.startsWith("notes/") ? full.slice("notes/".length) : full;
};

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
      : `k${generated}`.slice(0, maxLength);
    return next.length >= 4 ? next : `${next}xxxx`.slice(0, maxLength);
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

export const getNote = (name: string) => {
  const resourceName = noteNameOf(name);
  return resourceName.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(keep.getNotes({ name: resourceName }));
};

export const listNotes = () =>
  keep.listNotes
    .pages({
      pageSize: 100,
      filter: LIST_FILTER,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.notes ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => emptyList<keep.Note>()),
      Effect.catchTag("Forbidden", () => emptyList<keep.Note>()),
    );

export const listOwnedNotes = () =>
  listNotes().pipe(
    Effect.map((items) =>
      items.filter((item) => hasOwnershipMarker(item.title)),
    ),
  );

export const findOwnedNote = (id: string) =>
  Effect.gen(function* () {
    const items = yield* listOwnedNotes();
    for (const item of items) {
      if (yield* ownedByAlchemy(id, item.title)) {
        return item;
      }
    }
    return undefined;
  });

export const toListItem = (item: ListItemProps): keep.ListItem => ({
  text: { text: item.text },
  checked: item.checked,
  childListItems: item.childListItems?.map(toListItem),
});

export const fromListItem = (item: keep.ListItem): ListItemProps => ({
  text: item.text?.text ?? "",
  checked: item.checked,
  childListItems: item.childListItems?.map(fromListItem),
});

export const fromListItems = (
  items: keep.ListItemList | undefined,
): ListItemProps[] | undefined => {
  if (items === undefined) return undefined;
  return items.map(fromListItem);
};

export const desiredBody = (
  news: { text?: string; listItems?: ListItemProps[] },
  current: keep.Note | undefined,
): keep.Section | undefined => {
  if (news.listItems !== undefined) {
    return { list: { listItems: news.listItems.map(toListItem) } };
  }
  if (news.text !== undefined) {
    return { text: { text: news.text.slice(0, MAX_TEXT_LENGTH) } };
  }
  return current?.body;
};

export const writerEmails = (note: keep.Note | undefined): string[] =>
  (note?.permissions ?? [])
    .filter(
      (permission) =>
        permission.role === "WRITER" &&
        permission.deleted !== true &&
        (permission.email ?? "").length > 0,
    )
    .map((permission) => (permission.email ?? "").toLowerCase());

export const writerPermissionNames = (
  note: keep.Note | undefined,
  emails: Set<string>,
): string[] =>
  (note?.permissions ?? [])
    .filter(
      (permission) =>
        permission.role === "WRITER" &&
        permission.deleted !== true &&
        permission.name !== undefined &&
        emails.has((permission.email ?? "").toLowerCase()),
    )
    .map((permission) => permission.name as string);

export const normalizeEmails = (emails: string[] | undefined) =>
  (emails ?? []).map((email) => email.trim().toLowerCase()).filter(Boolean);
