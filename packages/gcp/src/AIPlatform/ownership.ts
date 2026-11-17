import { createPhysicalName } from "alchemy/PhysicalName";
import * as Effect from "effect/Effect";
import { alchemyLabelKeys, createInternalLabels, hasAlchemyLabels } from "../Labels.ts";

export const MAX_ID_LENGTH = 63;
export const MAX_DISPLAY_NAME_LENGTH = 128;

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const locationOf = (name: string, fallback = "") => {
  const parts = name.split("/");
  const index = parts.indexOf("locations");
  return index >= 0 ? (parts[index + 1] ?? fallback) : fallback;
};

export const parentOf = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  return parts.slice(0, -2).join("/");
};

export const locationParent = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

export const toResourceId = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = MAX_ID_LENGTH,
) =>
  Effect.gen(function* () {
    if (requested !== undefined) return requested;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
    });
    return /^[a-z]/.test(generated) ? generated : `a${generated}`.slice(0, maxLength);
  });

const markerOf = (labels: Record<string, string>) =>
  `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
): string => {
  const marker = markerOf(labels);
  return text ? `${marker}\n${text}` : marker;
};

/** The key a compact marker stores its stack/stage/id hash under. */
const HASH_KEY = "alchemy-hash";

// FNV-1a, twice with different seeds: deterministic and dependency-free.
const fnv = (value: string, seed: number) => {
  let hash = seed;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const ownershipHash = (labels: Record<string, string>) => {
  const key = [alchemyLabelKeys.stack, alchemyLabelKeys.stage, alchemyLabelKeys.id]
    .map((k) => labels[k] ?? "")
    .join("\u0000");
  return fnv(key, 0x811c9dc5) + fnv(key, 0x01000193);
};

/**
 * The marker, then the user's text, within `maxLength`. A marker that does not
 * fit (a long stack and stage) is written as a hash of the stack, stage and id
 * instead, so it is never cut and still identifies its owner.
 */
export const encodeOwnershipLine = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_DISPLAY_NAME_LENGTH,
): string => {
  const full = markerOf(labels);
  const marker = full.length <= maxLength ? full : `[alchemy ${HASH_KEY}=${ownershipHash(labels)}]`;
  if (!text) return marker;
  return `${marker} ${text}`.slice(0, maxLength);
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
  Object.keys(parseOwnership(text).labels).some((key) => key.startsWith("alchemy-"));

export const ownedByAlchemy = (id: string, text: string | undefined) =>
  Effect.gen(function* () {
    const { labels } = parseOwnership(text);
    const hash = labels[HASH_KEY];
    if (hash !== undefined) return hash === ownershipHash(yield* createInternalLabels(id));
    return yield* hasAlchemyLabels(id, labels);
  });

export const internalLabels = (id: string) => createInternalLabels(id);
