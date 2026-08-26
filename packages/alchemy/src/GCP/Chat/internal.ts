import * as chat from "@distilled.cloud/gcp/chat_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const SPACE_PREFIX = "spaces/";
export const EMOJI_PREFIX = "customEmojis/";
export const MAX_DISPLAY_NAME_LENGTH = 128;
export const MAX_DESCRIPTION_LENGTH = 150;
export const MAX_GUIDELINES_LENGTH = 5000;
export const MAX_EMOJI_NAME_LENGTH = 64;
export const MAX_CLIENT_MESSAGE_ID_LENGTH = 63;
export const DEFAULT_SPACE_TYPE = "SPACE";

export const DEFAULT_EMOJI_FILENAME = "alchemy.png";
export const DEFAULT_EMOJI_FILE_CONTENT =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsMtmORP7N4JvYbACS/W8FgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGBywJpKOGW3vVqMQAAAABJRU5ErkJggg==";

export const defaultEmojiPayload = (): chat.CustomEmojiPayload => ({
  fileContent: DEFAULT_EMOJI_FILE_CONTENT,
  filename: DEFAULT_EMOJI_FILENAME,
});

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameBoolean = (
  left: boolean | undefined,
  right: boolean | undefined,
) => (left ?? false) === (right ?? false);

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

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
): string => {
  const marker = fitMarker(labels, 8000);
  const trimmed = text?.trim();
  return trimmed && trimmed.length > 0 ? `${marker}\n${trimmed}` : marker;
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

export const toGeneratedName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = 40,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return requested.slice(0, maxLength);
    }
    if (existing !== undefined && existing.length > 0) {
      return existing.slice(0, maxLength);
    }
    const generated = yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
    });
    const next = /^[a-z]/.test(generated)
      ? generated
      : `g${generated}`.slice(0, maxLength);
    return next.length >= 4 ? next : `${next}xxxx`.slice(0, maxLength);
  });

const emptyList = <A>() => Effect.succeed([] as A[]);

type ChatOpError =
  | chat.NotFound
  | chat.Forbidden
  | chat.BadRequest
  | chat.Conflict
  | chat.GcpOpError;

export const catchMissing = <A, R>(effect: Effect.Effect<A, ChatOpError, R>) =>
  effect.pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
  );

export const ignoreMissing = <A, R>(effect: Effect.Effect<A, ChatOpError, R>) =>
  effect.pipe(
    Effect.catchTag("NotFound", () => Effect.void),
    Effect.catchTag("Forbidden", () => Effect.void),
  );

export const toSpaceName = (value: string) =>
  value.length === 0 || value.startsWith(SPACE_PREFIX)
    ? value
    : `${SPACE_PREFIX}${value}`;

export const spaceIdOf = (name: string) =>
  name.startsWith(SPACE_PREFIX)
    ? name.slice(SPACE_PREFIX.length)
    : lastSegment(name);

export const spaceOwnedText = (space: chat.Space) =>
  space.spaceDetails?.guidelines ?? space.displayName ?? space.name;

export const isOwnedSpace = (space: chat.Space) =>
  hasOwnershipMarker(space.spaceDetails?.guidelines) ||
  hasOwnershipMarker(space.displayName) ||
  hasOwnershipMarker(space.spaceDetails?.description);

export const getSpace = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(chat.getSpaces({ name: toSpaceName(name) }));

export const listSpaces = () =>
  chat.listSpaces.pages({ pageSize: 100, filter: 'space_type = "SPACE"' }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.spaces ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () => emptyList<chat.Space>()),
    Effect.catchTag("Forbidden", () => emptyList<chat.Space>()),
  );

export const listOwnedSpaces = () =>
  listSpaces().pipe(Effect.map((spaces) => spaces.filter(isOwnedSpace)));

export const findOwnedSpace = (id: string) =>
  Effect.gen(function* () {
    const spaces = yield* listSpaces();
    for (const space of spaces) {
      if (
        (yield* ownedByAlchemy(id, space.spaceDetails?.guidelines)) ||
        (yield* ownedByAlchemy(id, space.displayName))
      ) {
        return space;
      }
    }
    return undefined;
  });

export const toCustomEmojiName = (value: string) => {
  if (value.length === 0 || value.startsWith(EMOJI_PREFIX)) return value;
  return `${EMOJI_PREFIX}${value}`;
};

const collapseToken = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

export const toEmojiName = (raw: string) => {
  const inner = raw.replace(/^:+/, "").replace(/:+$/, "");
  const cleaned = collapseToken(inner);
  const body = (
    cleaned.startsWith("alch-") ? cleaned : `alch-${cleaned || "x"}`
  )
    .replace(/-+/g, "-")
    .slice(0, MAX_EMOJI_NAME_LENGTH - 2);
  return `:${body}:`;
};

export const isAlchemyEmojiName = (emojiName: string | undefined) =>
  (emojiName ?? "").replace(/^:+/, "").startsWith("alch-");

export const toEmojiNameFromId = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return toEmojiName(requested);
    }
    if (existing !== undefined && existing.length > 0) {
      return toEmojiName(existing);
    }
    const generated = yield* toGeneratedName(id, undefined, undefined, 32);
    return toEmojiName(generated);
  });

export const getCustomEmoji = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(chat.getCustomEmojis({ name: toCustomEmojiName(name) }));

export const listCustomEmojis = () =>
  chat.listCustomEmojis
    .pages({ pageSize: 200, filter: 'creator("users/me")' })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.customEmojis ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => emptyList<chat.CustomEmoji>()),
      Effect.catchTag("Forbidden", () => emptyList<chat.CustomEmoji>()),
    );

export const listOwnedCustomEmojis = () =>
  listCustomEmojis().pipe(
    Effect.map((emojis) =>
      emojis.filter((emoji) => isAlchemyEmojiName(emoji.emojiName)),
    ),
  );

export const findOwnedCustomEmoji = (emojiName: string) =>
  Effect.gen(function* () {
    const name = toEmojiName(emojiName);
    const direct = yield* getCustomEmoji(`${EMOJI_PREFIX}${name}`);
    if (direct !== undefined) return direct;
    const emojis = yield* listOwnedCustomEmojis();
    return emojis.find((emoji) => sameText(emoji.emojiName, name));
  });

export const toUserResourceName = (value: string) =>
  value.startsWith("users/") ? value : `users/${value}`;

export const toGroupResourceName = (value: string) =>
  value.startsWith("groups/") ? value : `groups/${value}`;

export const toMembershipName = (parent: string, member: string) => {
  if (member.length === 0) return "";
  if (member.includes("/members/")) {
    return member.startsWith(SPACE_PREFIX) ? member : toSpaceName(member);
  }
  const id = member.startsWith("users/")
    ? member.slice("users/".length)
    : member.startsWith("groups/")
      ? member
      : member;
  return `${toSpaceName(parent)}/members/${id}`;
};

export const membershipParentOf = (name: string) => {
  const parts = name.split("/");
  if (parts.length >= 2 && parts[0] === "spaces") {
    return `${parts[0]}/${parts[1]}`;
  }
  return "";
};

export const membershipMemberOf = (name: string) => {
  const index = name.indexOf("/members/");
  return index >= 0
    ? name.slice(index + "/members/".length)
    : lastSegment(name);
};

export const getMembership = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(chat.getSpacesMembers({ name }));

export const listMembers = (parent: string) =>
  parent.length === 0
    ? emptyList<chat.Membership>()
    : chat.listSpacesMembers
        .pages({
          parent: toSpaceName(parent),
          pageSize: 100,
          showGroups: true,
          showInvited: true,
        })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.memberships ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () => emptyList<chat.Membership>()),
          Effect.catchTag("Forbidden", () => emptyList<chat.Membership>()),
        );

export const listOwnedMembers = () =>
  Effect.gen(function* () {
    const spaces = yield* listOwnedSpaces();
    const pages = yield* Effect.forEach(
      spaces,
      (space) =>
        space.name ? listMembers(space.name) : emptyList<chat.Membership>(),
      { concurrency: 4 },
    );
    return pages.flat();
  });

export const findMembership = (
  parent: string,
  memberName: string | undefined,
  groupName: string | undefined,
  membershipName: string | undefined,
) =>
  Effect.gen(function* () {
    const directName =
      membershipName && membershipName.length > 0
        ? membershipName.includes("/members/")
          ? toMembershipName(parent, membershipName)
          : toMembershipName(parent, membershipName)
        : memberName
          ? toMembershipName(parent, memberName)
          : groupName
            ? toMembershipName(parent, toGroupResourceName(groupName))
            : "";
    const direct = yield* getMembership(directName);
    if (direct !== undefined) return direct;
    if (parent.length === 0) return undefined;
    const members = yield* listMembers(parent);
    return members.find((membership) => {
      if (directName.length > 0 && sameText(membership.name, directName)) {
        return true;
      }
      if (
        memberName &&
        (sameText(membership.member?.name, toUserResourceName(memberName)) ||
          sameText(membership.member?.name, memberName) ||
          sameText(membershipMemberOf(membership.name ?? ""), memberName) ||
          sameText(
            membershipMemberOf(membership.name ?? ""),
            memberName.replace(/^users\//, ""),
          ))
      ) {
        return true;
      }
      if (
        groupName &&
        sameText(membership.groupMember?.name, toGroupResourceName(groupName))
      ) {
        return true;
      }
      return false;
    });
  });

const sanitizeClientId = (value: string) => {
  const raw = value.toLowerCase().startsWith("client-")
    ? value
    : `client-${value}`;
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/-$/g, "");
  const next = cleaned.startsWith("client-") ? cleaned : `client-${cleaned}`;
  const sliced = next.slice(0, MAX_CLIENT_MESSAGE_ID_LENGTH);
  return sliced.length > "client-".length ? sliced : "client-x";
};

export const toClientMessageId = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return requested.startsWith("client-") || requested.includes("/")
        ? lastSegment(requested)
        : sanitizeClientId(requested);
    }
    if (existing !== undefined && existing.length > 0) {
      return existing;
    }
    const generated = yield* toGeneratedName(id, undefined, undefined, 48);
    return sanitizeClientId(generated);
  });

export const toMessageName = (parent: string, messageId: string) => {
  if (messageId.length === 0) return "";
  if (messageId.includes("/messages/")) {
    return messageId.startsWith(SPACE_PREFIX)
      ? messageId
      : toSpaceName(messageId);
  }
  return `${toSpaceName(parent)}/messages/${messageId}`;
};

export const messageParentOf = (name: string) => {
  const index = name.indexOf("/messages/");
  return index >= 0 ? name.slice(0, index) : "";
};

export const getMessage = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(chat.getSpacesMessages({ name }));

export const listMessages = (parent: string) =>
  parent.length === 0
    ? emptyList<chat.Message>()
    : chat.listSpacesMessages
        .pages({ parent: toSpaceName(parent), pageSize: 100 })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.messages ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () => emptyList<chat.Message>()),
          Effect.catchTag("Forbidden", () => emptyList<chat.Message>()),
        );

export const listOwnedMessages = () =>
  Effect.gen(function* () {
    const spaces = yield* listOwnedSpaces();
    const pages = yield* Effect.forEach(
      spaces,
      (space) =>
        space.name ? listMessages(space.name) : emptyList<chat.Message>(),
      { concurrency: 4 },
    );
    return pages.flat().filter((message) => hasOwnershipMarker(message.text));
  });

export const findOwnedMessage = (parent: string, id: string) =>
  Effect.gen(function* () {
    const messages = yield* listMessages(parent);
    for (const message of messages) {
      if (yield* ownedByAlchemy(id, message.text)) {
        return message;
      }
    }
    return undefined;
  });
