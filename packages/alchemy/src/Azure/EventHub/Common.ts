import * as eventhub from "@distilled.cloud/azure/eventhub";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { createPhysicalName } from "../../PhysicalName.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/** Observe an Event Hubs namespace; `undefined` when it does not exist. */
export const getNamespace = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
) =>
  orUndefinedIfNotFound(
    eventhub.GetNamespace({ subscriptionId, resourceGroupName, namespaceName }),
  );

/**
 * Children of a namespace (authorization rules, schema groups, the network
 * rule set) carry no tags or metadata. They count as owned when their parent
 * namespace carries this stack's and stage's ownership tags.
 */
export const namespaceOwnedByStage = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
) {
  const observed = yield* getNamespace(
    subscriptionId,
    resourceGroupName,
    namespaceName,
  );
  const { stack, stage } = yield* stackAndStage;
  return (
    observed?.tags?.["alchemy::stack"] === stack &&
    observed?.tags?.["alchemy::stage"] === stage
  );
});

const MARKER = /\s*\[alchemy ([^\]]+)\]$/;

/** Ownership marker appended to `userMetadata` (event hubs, consumer groups). */
export const ownershipMarker = Effect.fn(function* (id: string) {
  const { stack, stage } = yield* stackAndStage;
  return `[alchemy ${stack}/${stage}/${id}]`;
});

export const withMarker = (userMetadata: string | undefined, marker: string) =>
  userMetadata ? `${userMetadata} ${marker}` : marker;

/** User metadata with the Alchemy ownership marker stripped. */
export const stripMarker = (userMetadata: string | undefined) => {
  const stripped = userMetadata?.replace(MARKER, "");
  return stripped ? stripped : undefined;
};

export const hasAnyMarker = (userMetadata: string | undefined) =>
  MARKER.test(userMetadata ?? "");

/**
 * Name for an Event Hubs entity (event hub, consumer group, authorization
 * rule, schema group): letters, digits, periods, hyphens, and underscores,
 * starting and ending with a letter or digit.
 */
export const createEntityName = Effect.fn(function* (
  id: string,
  maxLength: number,
) {
  const name = yield* createPhysicalName({ id, maxLength });
  return name.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "");
});

/**
 * Globally unique namespace or cluster name: 6-50 letters, digits, and
 * hyphens, starting with a letter and ending with a letter or digit.
 */
export const createNamespaceName = Effect.fn(function* (id: string) {
  const name = (yield* createPhysicalName({
    id,
    maxLength: 50,
    lowercase: true,
  }))
    .replace(/-{2,}/g, "-")
    .replace(/-+$/, "");
  return /^[a-z]/.test(name) ? name : `n${name.slice(1)}`;
});

/**
 * True when every value set in `desired` equals the observed value
 * (recursively). Keys left `undefined` in `desired` are not compared.
 */
export const matchesObserved = (desired: unknown, observed: unknown): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      desired.length === observed.length &&
      desired.every((value, i) => matchesObserved(value, observed[i]))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    return Object.entries(desired).every(([key, value]) =>
      matchesObserved(value, (observed as Record<string, unknown>)[key]),
    );
  }
  return desired === observed;
};

/** SAS keys and connection strings of an authorization rule. */
export interface AuthorizationRuleKeys {
  /** Primary SAS key. */
  primaryKey: Redacted.Redacted<string> | undefined;
  /** Secondary SAS key. */
  secondaryKey: Redacted.Redacted<string> | undefined;
  /** Primary connection string. */
  primaryConnectionString: Redacted.Redacted<string> | undefined;
  /** Secondary connection string. */
  secondaryConnectionString: Redacted.Redacted<string> | undefined;
}

const redact = (value: string | undefined) =>
  value === undefined ? undefined : Redacted.make(value);

export const toKeys = (keys: eventhub.AccessKeys): AuthorizationRuleKeys => ({
  primaryKey: redact(keys.primaryKey),
  secondaryKey: redact(keys.secondaryKey),
  primaryConnectionString: redact(keys.primaryConnectionString),
  secondaryConnectionString: redact(keys.secondaryConnectionString),
});

export type AccessRight = "Manage" | "Send" | "Listen";

/** Rights compared as a set (Azure may reorder them). */
export const sameRights = (
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
) => {
  const left = [...(a ?? [])].map((r) => r.toLowerCase()).sort();
  const right = [...(b ?? [])].map((r) => r.toLowerCase()).sort();
  return (
    left.length === right.length && left.every((value, i) => value === right[i])
  );
};
