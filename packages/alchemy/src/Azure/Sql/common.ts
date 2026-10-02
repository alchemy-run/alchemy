import * as sql from "@distilled.cloud/azure/sql";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { createHash } from "node:crypto";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/** An ARM SKU for Azure SQL databases, elastic pools, and job agents. */
export interface SqlSku {
  /** SKU name, e.g. `Basic`, `S0`, `GP_S_Gen5_2`, `BasicPool`, `JA100`. */
  name: string;
  /** Tier (edition), e.g. `Basic`, `Standard`, `GeneralPurpose`. */
  tier?: string;
  /** Hardware family, e.g. `Gen5`. */
  family?: string;
  /** Capacity (DTUs, eDTUs, or vCores depending on the SKU). */
  capacity?: number;
}

export const lower = (value: string | undefined) => value?.toLowerCase();

export const sameId = (a: string | undefined, b: string | undefined) =>
  lower(a) === lower(b);

/**
 * Generate a DNS-label physical name (lowercase letters, digits, hyphens,
 * no leading/trailing hyphen) for globally unique SQL names.
 */
export const createDnsName = Effect.fn(function* (id: string, maxLength = 63) {
  const name = yield* createPhysicalName({ id, maxLength, lowercase: true });
  return name
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
});

/**
 * Generate a name for SQL child resources (databases, pools, rules, job
 * agents): up to 128 characters without `<>*%&:\/?`.
 */
export const createChildName = (id: string, maxLength = 128) =>
  createPhysicalName({ id, maxLength });

/**
 * Whether an observed SKU satisfies the desired SKU's specified fields.
 * DTU databases are requested by service objective (`S0`) but report the
 * edition (`Standard`) as the SKU name, so the current service objective
 * also counts as a name match.
 */
export const skuMatches = (
  observed: sql.DatabasePropertiesInputCurrentSku | undefined,
  desired: SqlSku,
  serviceObjective?: string,
) =>
  observed !== undefined &&
  (lower(observed.name) === lower(desired.name) ||
    lower(serviceObjective) === lower(desired.name)) &&
  (desired.tier === undefined ||
    lower(observed.tier) === lower(desired.tier)) &&
  (desired.family === undefined ||
    lower(observed.family) === lower(desired.family)) &&
  (desired.capacity === undefined || observed.capacity === desired.capacity);

/**
 * Salted SHA-256 fingerprint of a write-only secret (e.g. an administrator
 * password), so a change can be detected without persisting the secret.
 */
export const secretFingerprint = (
  salt: string,
  secret: Redacted.Redacted<string> | undefined,
) =>
  secret === undefined
    ? Effect.succeed(undefined)
    : Effect.sync(() =>
        Redacted.make(
          createHash("sha256")
            .update(`${salt}:${Redacted.value(secret)}`)
            .digest("hex"),
        ),
      );

export const sameSecret = (
  a: Redacted.Redacted<string> | undefined,
  b: Redacted.Redacted<string> | undefined,
) =>
  a !== undefined && b !== undefined && Redacted.value(a) === Redacted.value(b);

export const getServer = (
  subscriptionId: string,
  resourceGroupName: string,
  serverName: string,
) =>
  orUndefinedIfNotFound(
    sql.GetServer({ subscriptionId, resourceGroupName, serverName }),
  );

/**
 * Location of a SQL child resource: the explicit location, else the
 * parent server's location (children must live with their server).
 */
export const childLocation = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  serverName: string,
  explicit: string | undefined,
  fallback: string,
) {
  if (explicit !== undefined) return explicit;
  const server = yield* getServer(
    subscriptionId,
    resourceGroupName,
    serverName,
  );
  return server?.location ?? fallback;
});

/**
 * Whether every field written by a PATCH is reflected in the observed
 * properties (strings compared case-insensitively, objects as subsets).
 * SQL PATCHes are asynchronous and the resource keeps reporting its old
 * values (and a ready state) until the update lands.
 */
export const fieldsMatch = (
  observed: object | undefined,
  written: object,
  skip: readonly string[] = [],
): boolean =>
  Object.entries(written).every(([key, value]) => {
    if (value === undefined || skip.includes(key)) return true;
    const actual = (observed as Record<string, unknown> | undefined)?.[key];
    if (typeof value === "string") {
      return typeof actual === "string" && lower(actual) === lower(value);
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return (
        typeof actual === "object" &&
        actual !== null &&
        fieldsMatch(actual, value)
      );
    }
    return actual === value;
  });

/** Map a SQL resource's `state` (`Ready`) to ARM's `Succeeded`. */
export const readyState = (state: string | undefined) =>
  state === "Ready" ? "Succeeded" : (state ?? "Pending");

/**
 * Whether the SQL server is tagged as owned by the current stack and stage.
 * Server settings and children that cannot carry tags inherit ownership
 * from their server.
 */
export const isServerOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  serverName: string,
) {
  const server = yield* getServer(
    subscriptionId,
    resourceGroupName,
    serverName,
  );
  if (server === undefined) return false;
  const { stack, stage } = yield* stackAndStage;
  const tags = tagRecord(server.tags);
  return tags["alchemy::stack"] === stack && tags["alchemy::stage"] === stage;
});
