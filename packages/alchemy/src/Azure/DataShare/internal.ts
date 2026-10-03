import * as datashare from "@distilled.cloud/azure/datashare";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/*
 * Shared, un-exported helpers for the Data Share resources. Not re-exported
 * from `index.ts`.
 */

/** Case-insensitive name comparison (ARM names are case-insensitive). */
export const sameName = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/**
 * Name for a Data Share child (share, data set, synchronization setting,
 * invitation, share subscription, mapping, trigger): letters, digits, and
 * `_`, starting with a letter, at most 90 characters.
 */
export const createChildName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({ id, maxLength: 90, delimiter: "_" });
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, "_").replace(/_{2,}/g, "_");
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `s${cleaned}`.slice(0, 90);
});

/** Observe a Data Share account (undefined when missing). */
export const getAccount = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
) =>
  orUndefinedIfNotFound(
    datashare.GetAccount({ subscriptionId, resourceGroupName, accountName }),
  );

/**
 * Data Share children carry no tags or metadata, so ownership is inherited
 * from the parent account: a child is owned when its account carries this
 * stack's and stage's Alchemy tags. Child names embed the instance suffix,
 * so a name collision with a foreign resource of the same stack is not
 * possible.
 */
export const accountOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
) {
  const account = yield* getAccount(
    subscriptionId,
    resourceGroupName,
    accountName,
  );
  if (account === undefined) return false;
  const { stack, stage } = yield* stackAndStage;
  return (
    account.tags?.["alchemy::stack"] === stack &&
    account.tags?.["alchemy::stage"] === stage
  );
});

/** The kind-specific `properties` bag of a polymorphic Data Share object. */
export const kindProperties = (value: { properties?: unknown }) =>
  (typeof value.properties === "object" && value.properties !== null
    ? value.properties
    : {}) as Record<string, unknown>;

/** A string member of a kind-specific properties bag. */
export const stringProp = (bag: Record<string, unknown>, key: string) => {
  const value = bag[key];
  return typeof value === "string" ? value : undefined;
};

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : typeof value === "object" && value !== null
      ? Object.keys(value)
          .sort()
          .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
          .map((key) => [key, canonical((value as Record<string, unknown>)[key])])
      : value;

/**
 * Whether an immutable input changed. An unresolved input (an output of an
 * upstream resource being created or replaced) counts as changed: stable
 * upstream attributes are resolved at plan time.
 */
export const immutableChanged = (
  next: unknown,
  prev: unknown,
  options: { caseInsensitive?: boolean } = {},
) => {
  if (!isResolved(next)) return true;
  if (
    options.caseInsensitive &&
    typeof next === "string" &&
    typeof prev === "string"
  ) {
    return next.toLowerCase() !== prev.toLowerCase();
  }
  return JSON.stringify(canonical(next)) !== JSON.stringify(canonical(prev));
};
