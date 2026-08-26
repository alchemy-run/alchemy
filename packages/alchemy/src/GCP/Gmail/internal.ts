import * as gmail from "@distilled.cloud/gcp/gmail_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const DEFAULT_USER = "me";
export const MAX_LABEL_NAME_LENGTH = 225;
export const MAX_SUBJECT_LENGTH = 180;
export const MAX_DISPLAY_NAME_LENGTH = 100;
export const OWNERSHIP_QUERY = 'subject:"[alchemy"';

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
  maxLength = MAX_SUBJECT_LENGTH,
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

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  jsonEqual(
    [...(left ?? [])].slice().sort(),
    [...(right ?? [])].slice().sort(),
  );

export const toUserId = (
  requested: string | undefined,
  existing: string | undefined,
) => requested ?? existing ?? DEFAULT_USER;

export const isAlchemyEmail = (email: string | undefined) => {
  const value = (email ?? "").toLowerCase();
  const local = value.split("@")[0] ?? "";
  return local.startsWith("alchemy-") || local.includes("+alchemy-");
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
      : `g${generated}`.slice(0, maxLength);
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

export const headerOf = (
  payload: gmail.MessagePart | undefined,
  name: string,
) =>
  payload?.headers?.find(
    (header) => header.name?.toLowerCase() === name.toLowerCase(),
  )?.value;

export const decodeBase64Url = (raw: string): string => {
  try {
    return Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return "";
  }
};

export const encodeBase64Url = (text: string) =>
  Effect.sync(() => Buffer.from(text, "utf8").toString("base64url"));

const subjectFromRaw = (raw: string | undefined) => {
  if (raw === undefined || raw.length === 0) return undefined;
  const decoded = decodeBase64Url(raw);
  const match = decoded.match(/^subject:\s*(.*)$/im);
  return match?.[1]?.trim();
};

export const messageSubject = (message: gmail.Message | undefined) =>
  headerOf(message?.payload, "Subject") ?? subjectFromRaw(message?.raw);

export const messageHeader = (
  message: gmail.Message | undefined,
  name: string,
) => headerOf(message?.payload, name);

export const messageBody = (message: gmail.Message | undefined) => {
  const data = message?.payload?.body?.data;
  if (data !== undefined && data.length > 0) {
    return decodeBase64Url(data);
  }
  const part = message?.payload?.parts?.find(
    (entry) => entry.mimeType === "text/plain" || entry.body?.data,
  );
  if (part?.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  return undefined;
};

export const buildRfc2822 = (fields: {
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body?: string;
}) => {
  const lines: string[] = [];
  if (fields.from) lines.push(`From: ${fields.from}`);
  if (fields.to) lines.push(`To: ${fields.to}`);
  if (fields.cc) lines.push(`Cc: ${fields.cc}`);
  if (fields.bcc) lines.push(`Bcc: ${fields.bcc}`);
  lines.push(`Subject: ${fields.subject}`);
  lines.push("MIME-Version: 1.0");
  lines.push("Content-Type: text/plain; charset=UTF-8");
  lines.push("");
  lines.push(fields.body ?? "");
  return lines.join("\r\n");
};

export const stampRawMessage = (input: {
  labels: Record<string, string>;
  subject?: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  body?: string;
  raw?: string;
}) =>
  Effect.gen(function* () {
    const subject = encodeOwnershipLine(input.labels, input.subject);
    if (input.raw !== undefined && input.raw.length > 0) {
      const decoded = yield* Effect.sync(() => decodeBase64Url(input.raw!));
      const lines: string[] = decoded.split(/\r?\n/);
      let found = false;
      const next = lines.map((line: string) => {
        if (/^subject:/i.test(line)) {
          found = true;
          return `Subject: ${subject}`;
        }
        return line;
      });
      if (!found) {
        next.unshift(`Subject: ${subject}`);
      }
      return yield* encodeBase64Url(next.join("\r\n"));
    }
    return yield* encodeBase64Url(
      buildRfc2822({
        from: input.from,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject,
        body: input.body,
      }),
    );
  });

export const getLabel = (userId: string, labelId: string) =>
  labelId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(gmail.getUsersLabels({ userId, id: labelId }));

export const listLabels = (userId: string) =>
  gmail.listUsersLabels({ userId }).pipe(
    Effect.map((page) => page.labels ?? []),
    Effect.catchTag("NotFound", () => emptyList<gmail.Label>()),
    Effect.catchTag("Forbidden", () => emptyList<gmail.Label>()),
  );

export const findLabelByName = (userId: string, name: string) =>
  listLabels(userId).pipe(
    Effect.map((labels) => labels.find((label) => label.name === name)),
  );

export const getDraft = (userId: string, draftId: string) =>
  draftId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        gmail.getUsersDrafts({ userId, id: draftId, format: "full" }),
      );

export const listDrafts = (userId: string) =>
  gmail.listUsersDrafts
    .pages({ userId, maxResults: 100, q: OWNERSHIP_QUERY })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.drafts ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => emptyList<gmail.Draft>()),
      Effect.catchTag("Forbidden", () => emptyList<gmail.Draft>()),
    );

export const listOwnedDrafts = (userId: string) =>
  Effect.gen(function* () {
    const summaries = yield* listDrafts(userId);
    const drafts = yield* Effect.forEach(
      summaries.filter((draft) => (draft.id ?? "").length > 0),
      (draft) => getDraft(userId, draft.id ?? ""),
      { concurrency: 4 },
    );
    return drafts.filter(
      (draft): draft is gmail.Draft =>
        draft !== undefined &&
        hasOwnershipMarker(messageSubject(draft.message)),
    );
  });

export const findOwnedDraft = (userId: string, id: string) =>
  Effect.gen(function* () {
    const drafts = yield* listOwnedDrafts(userId);
    for (const draft of drafts) {
      if (yield* ownedByAlchemy(id, messageSubject(draft.message))) {
        return draft;
      }
    }
    return undefined;
  });

export const getMessage = (userId: string, messageId: string) =>
  messageId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        gmail.getUsersMessages({ userId, id: messageId, format: "full" }),
      );

export const listMessages = (userId: string) =>
  gmail.listUsersMessages
    .pages({
      userId,
      maxResults: 100,
      q: OWNERSHIP_QUERY,
      includeSpamTrash: true,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.messages ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => emptyList<gmail.Message>()),
      Effect.catchTag("Forbidden", () => emptyList<gmail.Message>()),
    );

export const listOwnedMessages = (userId: string) =>
  Effect.gen(function* () {
    const summaries = yield* listMessages(userId);
    const messages = yield* Effect.forEach(
      summaries.filter((message) => (message.id ?? "").length > 0),
      (message) => getMessage(userId, message.id ?? ""),
      { concurrency: 4 },
    );
    return messages.filter(
      (message): message is gmail.Message =>
        message !== undefined && hasOwnershipMarker(messageSubject(message)),
    );
  });

export const findOwnedMessage = (userId: string, id: string) =>
  Effect.gen(function* () {
    const messages = yield* listOwnedMessages(userId);
    for (const message of messages) {
      if (yield* ownedByAlchemy(id, messageSubject(message))) {
        return message;
      }
    }
    return undefined;
  });

export const getFilter = (userId: string, filterId: string) =>
  filterId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(gmail.getUsersSettingsFilters({ userId, id: filterId }));

export const listFilters = (userId: string) =>
  gmail.listUsersSettingsFilters({ userId }).pipe(
    Effect.map((page) => page.filter ?? []),
    Effect.catchTag("NotFound", () => emptyList<gmail.Filter>()),
    Effect.catchTag("Forbidden", () => emptyList<gmail.Filter>()),
  );

export const findOwnedFilter = (userId: string, id: string) =>
  Effect.gen(function* () {
    const filters = yield* listFilters(userId);
    for (const filter of filters) {
      if (
        (yield* ownedByAlchemy(id, filter.criteria?.subject)) ||
        (yield* ownedByAlchemy(id, filter.criteria?.query))
      ) {
        return filter;
      }
    }
    return undefined;
  });

export const getSendAs = (userId: string, sendAsEmail: string) =>
  sendAsEmail.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(gmail.getUsersSettingsSendAs({ userId, sendAsEmail }));

export const listSendAs = (userId: string) =>
  gmail.listUsersSettingsSendAs({ userId }).pipe(
    Effect.map((page) => page.sendAs ?? []),
    Effect.catchTag("NotFound", () => emptyList<gmail.SendAs>()),
    Effect.catchTag("Forbidden", () => emptyList<gmail.SendAs>()),
  );

export const sendAsOwnershipText = (alias: gmail.SendAs) =>
  alias.signature ?? alias.displayName;

export const getDelegate = (userId: string, delegateEmail: string) =>
  delegateEmail.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(gmail.getUsersSettingsDelegates({ userId, delegateEmail }));

export const listDelegates = (userId: string) =>
  gmail.listUsersSettingsDelegates({ userId }).pipe(
    Effect.map((page) => page.delegates ?? []),
    Effect.catchTag("NotFound", () => emptyList<gmail.Delegate>()),
    Effect.catchTag("Forbidden", () => emptyList<gmail.Delegate>()),
  );

export const getForwardingAddress = (
  userId: string,
  forwardingEmail: string,
) =>
  forwardingEmail.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        gmail.getUsersSettingsForwardingAddresses({
          userId,
          forwardingEmail,
        }),
      );

export const listForwardingAddresses = (userId: string) =>
  gmail.listUsersSettingsForwardingAddresses({ userId }).pipe(
    Effect.map((page) => page.forwardingAddresses ?? []),
    Effect.catchTag("NotFound", () => emptyList<gmail.ForwardingAddress>()),
    Effect.catchTag("Forbidden", () => emptyList<gmail.ForwardingAddress>()),
  );

export const getCseIdentity = (userId: string, emailAddress: string) =>
  emailAddress.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        gmail.getUsersSettingsCseIdentities({
          userId,
          cseEmailAddress: emailAddress,
        }),
      );

export const listCseIdentities = (userId: string) =>
  gmail.listUsersSettingsCseIdentities.pages({ userId, pageSize: 100 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.cseIdentities ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () => emptyList<gmail.CseIdentity>()),
    Effect.catchTag("Forbidden", () => emptyList<gmail.CseIdentity>()),
  );

export const smtpPublicOf = (smtp: gmail.SmtpMsa | undefined) => {
  if (smtp === undefined) return undefined;
  return {
    host: smtp.host,
    port: smtp.port,
    securityMode: smtp.securityMode,
    username: smtp.username,
  };
};

export const desiredFilterCriteria = (
  labels: Record<string, string>,
  criteria: gmail.FilterCriteria | undefined,
): gmail.FilterCriteria => ({
  negatedQuery: criteria?.negatedQuery,
  sizeComparison: criteria?.sizeComparison,
  excludeChats: criteria?.excludeChats,
  size: criteria?.size,
  from: criteria?.from,
  query: criteria?.query,
  subject: encodeOwnershipLine(labels, criteria?.subject),
  to: criteria?.to,
  hasAttachment: criteria?.hasAttachment,
});

export const listSmime = (userId: string, sendAsEmail: string) =>
  sendAsEmail.length === 0
    ? emptyList<gmail.SmimeInfo>()
    : gmail.listUsersSettingsSendAsSmimeInfo({ userId, sendAsEmail }).pipe(
        Effect.map((page) => page.smimeInfo ?? []),
        Effect.catchTag("NotFound", () => emptyList<gmail.SmimeInfo>()),
        Effect.catchTag("Forbidden", () => emptyList<gmail.SmimeInfo>()),
      );

export const getSmime = (userId: string, sendAsEmail: string, id: string) =>
  id.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        gmail.getUsersSettingsSendAsSmimeInfo({
          userId,
          sendAsEmail,
          id,
        }),
      );

export const findSmime = (
  userId: string,
  sendAsEmail: string,
  smimeInfoId: string,
) =>
  smimeInfoId.length === 0
    ? Effect.succeed(undefined)
    : getSmime(userId, sendAsEmail, smimeInfoId).pipe(
        Effect.flatMap((existing) =>
          existing !== undefined
            ? Effect.succeed(existing)
            : listSmime(userId, sendAsEmail).pipe(
                Effect.map((infos) =>
                  infos.find((info) => info.id === smimeInfoId),
                ),
              ),
        ),
      );

export const findSmimeAfterConflict = (userId: string, sendAsEmail: string) =>
  listSmime(userId, sendAsEmail).pipe(Effect.map((infos) => infos.at(-1)));
