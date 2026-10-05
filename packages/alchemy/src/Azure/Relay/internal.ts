import type * as relay from "@distilled.cloud/azure/relay";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { createPhysicalName } from "../../PhysicalName.ts";
import { stackAndStage } from "../Arm.ts";

/*
 * Shared, un-exported helpers for the Relay resources. Not re-exported
 * from `index.ts`.
 */

export type AccessRight = relay.AccessRights;

/** `[alchemy <stack>/<stage>/<id>]` — ownership marker for entities without tags. */
export const ownershipMarker = Effect.fn(function* (id: string) {
  const { stack, stage } = yield* stackAndStage;
  return `[alchemy ${stack}/${stage}/${id}]`;
});

const MARKER = /\s*\[alchemy [^\]]+\]$/;

/** User metadata with the ownership marker appended. */
export const metadataWithMarker = (
  userMetadata: string | undefined,
  marker: string,
) => (userMetadata ? `${userMetadata} ${marker}` : marker);

/** User metadata with any ownership marker stripped. */
export const stripMarker = (userMetadata: string | undefined) => {
  const stripped = (userMetadata ?? "").replace(MARKER, "");
  return stripped === "" ? undefined : stripped;
};

/** Whether the observed metadata ends with this stack/stage/id's marker. */
export const hasMarker = Effect.fn(function* (
  id: string,
  userMetadata: string | undefined,
) {
  return (userMetadata ?? "").endsWith(yield* ownershipMarker(id));
});

/**
 * Entity name (hybrid connection, WCF relay, authorization rule): letters,
 * digits, `-`; starts and ends with a letter or digit. Relay entity names
 * are case-insensitive, so they are generated lowercase.
 */
export const createEntityName = Effect.fn(function* (
  id: string,
  maxLength: number,
) {
  const name = yield* createPhysicalName({ id, maxLength, lowercase: true });
  return name
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "");
});

/** `Manage` implies `Listen` and `Send`; rights are compared sorted. */
export const normalizeRights = (
  rights: ReadonlyArray<string>,
): AccessRight[] => {
  const set = new Set(rights.map((right) => right.toLowerCase()));
  if (set.has("manage")) {
    set.add("listen");
    set.add("send");
  }
  const canonical: AccessRight[] = ["Listen", "Manage", "Send"];
  return canonical.filter((right) => set.has(right.toLowerCase()));
};

export const rightsEqual = (
  observed: ReadonlyArray<string> | undefined,
  desired: ReadonlyArray<string>,
) =>
  normalizeRights(observed ?? []).join(",") ===
  normalizeRights(desired).join(",");

export interface ConnectionSecrets {
  /** Primary key (base64 256-bit SAS signing key). */
  primaryKey: Redacted.Redacted<string> | undefined;
  /** Secondary key. */
  secondaryKey: Redacted.Redacted<string> | undefined;
  /** Primary connection string. */
  primaryConnectionString: Redacted.Redacted<string> | undefined;
  /** Secondary connection string. */
  secondaryConnectionString: Redacted.Redacted<string> | undefined;
}

const redact = (value: string | undefined) =>
  value === undefined ? undefined : Redacted.make(value);

export const toSecrets = (keys: relay.AccessKeys): ConnectionSecrets => ({
  primaryKey: redact(keys.primaryKey),
  secondaryKey: redact(keys.secondaryKey),
  primaryConnectionString: redact(keys.primaryConnectionString),
  secondaryConnectionString: redact(keys.secondaryConnectionString),
});

export const sameName = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();
