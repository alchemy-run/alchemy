import { unownedUnlessPrevious } from "alchemy/AdoptPolicy";
import { deepEqual } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

/**
 * Galaxy's rule for one kind of object name, as Galaxy enforces it (read
 * from its error responses; the API spec states none). Every kind takes
 * lowercase letters and digits after a leading letter, plus `delimiter`.
 */
export interface NameRule {
  readonly maxLength: number;
  readonly delimiter: "_" | "-";
  /** Prefixes Galaxy reserves (matched case-insensitively). */
  readonly forbiddenPrefixes?: ReadonlyArray<string>;
}

/** Catalogs: at most 64 chars, `[a-z0-9_]`; `starburst*`, `galaxy*` and `system*` are reserved. */
export const CATALOG_NAME: NameRule = {
  maxLength: 64,
  delimiter: "_",
  forbiddenPrefixes: ["starburst", "galaxy", "system"],
};
/** Roles: 1 to 64 chars, `[a-z0-9_]` (Galaxy's own error message). */
export const ROLE_NAME: NameRule = { maxLength: 64, delimiter: "_" };
/** Service account user names: `_` and `-` both accepted; 63 chars accepted. */
export const SERVICE_ACCOUNT_NAME: NameRule = { maxLength: 63, delimiter: "_" };
/** Tags (31 chars accepted), column masks and row filters (30): `[a-z0-9_]`. */
export const GOVERNANCE_NAME: NameRule = { maxLength: 30, delimiter: "_" };
/** Clusters: part of the Trino host name, `[a-z0-9-]`, at most 30 chars. */
export const CLUSTER_NAME: NameRule = { maxLength: 30, delimiter: "-" };
/** Data domains: free text (100 chars accepted). */
export const DATA_DOMAIN_NAME: NameRule = { maxLength: 63, delimiter: "-" };
/** SQL jobs: the cluster rule, the strictest Galaxy applies to a `-` name. */
export const SQL_JOB_NAME: NameRule = { maxLength: 30, delimiter: "-" };

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

/**
 * The name Galaxy stores for an object: the explicit `name`, else one
 * generated under `rule` from the stack, logical id, stage and the
 * resource's instance id (a name too long keeps a hash of the whole and the
 * instance suffix). Galaxy objects carry no labels or tags, so this
 * generated name is the ownership marker.
 */
export const physicalName = (id: string, name: string | undefined, rule: NameRule) =>
  name !== undefined
    ? Effect.succeed(name)
    : createPhysicalName({
        id,
        lowercase: true,
        delimiter: rule.delimiter,
        maxLength: rule.maxLength,
        // Every Galaxy name starts with a letter: a leading digit gets `x` + delimiter too.
        forbiddenPrefixes: [...(rule.forbiddenPrefixes ?? []), ...DIGITS],
      }).pipe(Effect.map((generated) => generated.replaceAll(/[-_]/g, rule.delimiter)));

/** The first element of a paginated stream that matches, reading no further pages. */
export const findFirst = <A, E, R>(stream: Stream.Stream<A, E, R>, predicate: (a: A) => boolean) =>
  stream.pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrUndefined));

/** Every element of a paginated stream, mapped. Errors fail the list. */
export const collectAll = <A, B, E, R>(stream: Stream.Stream<A, E, R>, f: (a: A) => B) =>
  stream.pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk, f)),
  );

/**
 * Ownership of an object found while reading. Galaxy has no tags, so an
 * object found under a generated name is ours (the name carries this
 * resource's instance id), as is one this resource already recorded. One
 * found under an explicit, user-chosen name without prior state may belong
 * to someone else, unless it is the generation a replacement is replacing.
 */
export const ownership = <T extends object, K extends keyof T>(
  attrs: T,
  input: {
    readonly output: object | undefined;
    readonly explicitName: string | undefined;
    readonly previous: Partial<Record<K, unknown>> | undefined;
    readonly key: K;
  },
): T =>
  input.output !== undefined || input.explicitName === undefined
    ? attrs
    : unownedUnlessPrevious(attrs, input.previous, input.key);

/**
 * The fields of `desired` that differ from what Galaxy reports, for a
 * PATCH that sends only the delta. Fields left `undefined` in `desired` are
 * Galaxy's to keep.
 */
export const changedFields = <T extends Record<string, unknown>>(
  observed: Partial<Record<keyof T, unknown>>,
  desired: T,
): Partial<T> => {
  const delta: Partial<T> = {};
  for (const key of Object.keys(desired) as Array<keyof T>) {
    if (desired[key] !== undefined && !deepEqual(observed[key], desired[key])) {
      delta[key] = desired[key];
    }
  }
  return delta;
};

/** Whether a delta from {@link changedFields} has anything to send. */
export const hasChanges = (delta: object) => Object.keys(delta).length > 0;

/** Order-insensitive equality of id lists Galaxy may return in any order. */
export const sameIds = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000");

/** Roles every Galaxy account has; they cannot be deleted, so `list` leaves them out. */
export const BUILT_IN_ROLES: Record<string, true> = { accountadmin: true, public: true };
