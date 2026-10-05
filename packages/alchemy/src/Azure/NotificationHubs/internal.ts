import type * as notificationhubs from "@distilled.cloud/azure/notificationhubs";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { createHash } from "node:crypto";
import { createPhysicalName } from "../../PhysicalName.ts";

/*
 * Shared, un-exported helpers for the Notification Hubs resources. Not
 * re-exported from `index.ts`.
 */

export type AccessRight = notificationhubs.AccessRights;

/**
 * Entity name (notification hub, authorization rule): letters, digits, `-`;
 * starts and ends with a letter or digit. Names are case-insensitive, so
 * they are generated lowercase.
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

/** `Manage` requires `Listen` and `Send`; rights are compared sorted. */
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

export const toSecrets = (
  keys: notificationhubs.ResourceListKeys,
): ConnectionSecrets => ({
  primaryKey: redact(keys.primaryKey),
  secondaryKey: redact(keys.secondaryKey),
  primaryConnectionString: redact(keys.primaryConnectionString),
  secondaryConnectionString: redact(keys.secondaryConnectionString),
});

export const sameName = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

export const sameLocation = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase().replace(/\s/g, "") === b?.toLowerCase().replace(/\s/g, "");

/** Push notification service credentials (APNs, FCM/GCM, WNS, ...). */
export type PnsCredentials = notificationhubs.PnsCredentials;

const CREDENTIAL_KINDS = [
  "admCredential",
  "apnsCredential",
  "baiduCredential",
  "browserCredential",
  "gcmCredential",
  "mpnsCredential",
  "wnsCredential",
  "xiaomiCredential",
] as const satisfies ReadonlyArray<keyof PnsCredentials>;

const canonical = (value: unknown): unknown => {
  if (Redacted.isRedacted(value)) return Redacted.value(value);
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .flatMap((key) => {
          const field = (value as Record<string, unknown>)[key];
          return field === undefined ? [] : [[key, canonical(field)]];
        }),
    );
  }
  return value;
};

/**
 * sha256 of the desired credentials (secrets unwrapped). ARM masks secrets
 * on read, so the hash recorded in the attributes is the change signal.
 */
export const hashCredentials = (credentials: PnsCredentials | undefined) =>
  Effect.sync(() =>
    credentials === undefined
      ? undefined
      : createHash("sha256")
          .update(JSON.stringify(canonical(credentials)))
          .digest("hex"),
  );

/** Credential kinds set in `credentials` (e.g. `apnsCredential`). */
export const credentialKinds = (credentials: PnsCredentials | undefined) =>
  CREDENTIAL_KINDS.filter((kind) => credentials?.[kind] !== undefined);

/**
 * Whether desired credentials must be written: a kind the user set is
 * missing in the cloud, or the desired values changed since the last write.
 */
export const credentialsNeedWrite = (
  observed: PnsCredentials | undefined,
  desired: PnsCredentials | undefined,
  desiredHash: string | undefined,
  lastHash: string | undefined,
) =>
  desired !== undefined &&
  (desiredHash !== lastHash ||
    credentialKinds(desired).some((kind) => observed?.[kind] === undefined));
