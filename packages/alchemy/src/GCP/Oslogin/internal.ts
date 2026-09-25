import * as oslogin from "@distilled.cloud/gcp/oslogin_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const DEFAULT_USER = "me";
export const MAX_COMMENT_LENGTH = 256;

export type ParsedSshKey = {
  type: string;
  blob: string;
  comment: string | undefined;
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
  maxLength = MAX_COMMENT_LENGTH,
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

export const parseSshKey = (key: string | undefined): ParsedSshKey => {
  const trimmed = (key ?? "").trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) {
    return { type: "", blob: trimmed, comment: undefined };
  }
  const type = parts[0] ?? "";
  const blob = parts[1] ?? "";
  const comment = parts.slice(2).join(" ").trim();
  return {
    type,
    blob,
    comment: comment.length > 0 ? comment : undefined,
  };
};

export const formatSshKey = (parsed: ParsedSshKey): string =>
  [parsed.type, parsed.blob, parsed.comment]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(" ");

export const keyIdentity = (key: string | undefined) => {
  const parsed = parseSshKey(key);
  return `${parsed.type} ${parsed.blob}`.trim();
};

export const sameKeyMaterial = (
  left: string | undefined,
  right: string | undefined,
) => keyIdentity(left) === keyIdentity(right);

export const stampKey = (
  key: string,
  labels: Record<string, string>,
  comment: string | undefined,
) => {
  const parsed = parseSshKey(key);
  return formatSshKey({
    type: parsed.type,
    blob: parsed.blob,
    comment: encodeOwnershipLine(labels, comment, MAX_COMMENT_LENGTH),
  });
};

export const unstampKey = (key: string | undefined) => {
  const parsed = parseSshKey(key);
  return formatSshKey({
    type: parsed.type,
    blob: parsed.blob,
    comment: parseOwnership(parsed.comment).text,
  });
};

export const keyComment = (key: string | undefined) =>
  parseOwnership(parseSshKey(key).comment).text;

export const normalizeUser = (user: string | undefined) => {
  const raw = (user ?? DEFAULT_USER).trim();
  const id = raw.startsWith("users/") ? raw.slice("users/".length) : raw;
  return id.length > 0 ? id : DEFAULT_USER;
};

export const toUserId = (
  requested: string | undefined,
  existing: string | undefined,
) => normalizeUser(requested ?? existing ?? DEFAULT_USER);

const ME_CREDENTIAL_MISMATCH = /credential for \[([^\]]+)\]/i;

let resolvedMe: string | undefined;

/**
 * `users/me` is valid for user OAuth tokens. Service accounts get
 * Forbidden: the caller must use `users/{sa-email}` instead. Parse that
 * email out of the typed error so reconcile/list keep working.
 */
export const resolveUser = (user: string) =>
  Effect.gen(function* () {
    const id = normalizeUser(user);
    if (id !== DEFAULT_USER) return id;
    if (resolvedMe !== undefined) return resolvedMe;
    const matched = yield* oslogin
      .getLoginProfileUsers({ name: "users/me" })
      .pipe(
        Effect.as(DEFAULT_USER),
        Effect.catchTag("Forbidden", (error) => {
          const match = ME_CREDENTIAL_MISMATCH.exec(error.message);
          return match?.[1] !== undefined
            ? Effect.succeed(match[1])
            : Effect.fail(error);
        }),
      );
    resolvedMe = matched;
    return matched;
  });

export const toUserParent = (user: string) => {
  const id = normalizeUser(user);
  return id.startsWith("users/") ? id : `users/${id}`;
};

export const userOf = (name: string | undefined, fallback = DEFAULT_USER) => {
  if (!name) return fallback;
  const match = name.match(/^users\/([^/]+)/);
  return match?.[1] ?? fallback;
};

export const fingerprintOf = (
  name: string | undefined,
  fingerprint?: string,
) => {
  if (fingerprint && fingerprint.length > 0) return fingerprint;
  if (!name) return "";
  const parts = name.split("/sshPublicKeys/");
  return parts[1] ?? "";
};

export const resourceName = (user: string, fingerprint: string) =>
  `${toUserParent(user)}/sshPublicKeys/${fingerprint}`;

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
      (
        error,
      ): error is E & {
        readonly _tag: "NotFound" | "Forbidden" | "Conflict";
      } =>
        error._tag === "NotFound" ||
        error._tag === "Forbidden" ||
        error._tag === "Conflict",
      () => Effect.void,
    ),
  );

export const retryConflict = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (e) => e._tag === "Conflict",
      times: 8,
      schedule: Schedule.spaced("400 millis"),
    }),
  );

export const getSshPublicKey = (name: string) => {
  if (name.length === 0) return Effect.succeed(undefined);
  return catchMissing(oslogin.getUsersSshPublicKeys({ name }));
};

export const listSshPublicKeys = (user: string, project?: string) =>
  oslogin
    .getLoginProfileUsers({
      name: toUserParent(user),
      projectId: project,
    })
    .pipe(
      Effect.map((profile) =>
        Object.values(profile.sshPublicKeys ?? {}).filter(
          (key): key is oslogin.SshPublicKey => key !== undefined,
        ),
      ),
      Effect.catchTag("NotFound", () => emptyList<oslogin.SshPublicKey>()),
      Effect.catchTag("Forbidden", () => emptyList<oslogin.SshPublicKey>()),
    );

export const listOwnedKeys = (user: string, project?: string) =>
  listSshPublicKeys(user, project).pipe(
    Effect.map((items) =>
      items.filter(
        (item) =>
          hasOwnershipMarker(item.key) ||
          hasOwnershipMarker(parseSshKey(item.key).comment),
      ),
    ),
  );

export const findOwnedKey = (
  user: string,
  id: string,
  options: {
    name?: string;
    fingerprint?: string;
    key?: string;
    project?: string;
  },
) =>
  Effect.gen(function* () {
    const name =
      options.name && options.name.length > 0
        ? options.name
        : options.fingerprint && options.fingerprint.length > 0
          ? resourceName(user, options.fingerprint)
          : "";
    const byName = yield* getSshPublicKey(name);
    if (byName !== undefined) return byName;

    const items = yield* listSshPublicKeys(user, options.project);
    if (options.key) {
      const byBlob = items.find(
        (item) =>
          sameKeyMaterial(item.key, options.key) &&
          hasOwnershipMarker(item.key),
      );
      if (byBlob !== undefined) return byBlob;
    }
    for (const item of items) {
      if (
        options.key !== undefined &&
        !sameKeyMaterial(item.key, options.key)
      ) {
        continue;
      }
      if (yield* ownedByAlchemy(id, parseSshKey(item.key).comment)) {
        return item;
      }
    }
    return undefined;
  });
