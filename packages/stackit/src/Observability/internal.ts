/**
 * Shared scaffolding for the STACKIT Observability resources. Not exported from
 * the namespace barrel.
 *
 * The product was called Argus, and its host and IAM actions still say so. Nothing
 * in it takes labels, so ownership goes by state and by generated names.
 */
import * as observability from "@distilled.cloud/stackit/observability";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { secretsDiffer } from "../internal/equal.ts";
import { makeKeyedLock } from "../internal/lock.ts";
import { isGeneratedPhysicalName } from "../internal/names.ts";

/** Instance create budget (the Go SDK's `CreateInstanceWaitHandler`). */
export const INSTANCE_CREATE_TIMEOUT = "45 minutes";
/** Instance update budget (the Go SDK's `UpdateInstanceWaitHandler`). */
export const INSTANCE_UPDATE_TIMEOUT = "30 minutes";
/** Instance delete budget (the Go SDK's `DeleteInstanceWaitHandler`). */
export const INSTANCE_DELETE_TIMEOUT = "20 minutes";
/** How long a written object may take to read back (the Go SDK's `CreateScrapeConfigWaitHandler`). */
export const CONFIG_TIMEOUT = "5 minutes";
/** How long a deleted object may keep reading back (the Go SDK's `DeleteScrapeConfigWaitHandler`). */
export const CONFIG_DELETE_TIMEOUT = "3 minutes";
/** Poll an instance slowly: it takes minutes, and the budget is long. */
export const INSTANCE_POLL = { interval: "5 seconds", maxInterval: "30 seconds" } as const;

/**
 * Instance names, scrape job names and alert group names are at most 200
 * characters (`CreateInstancePayload`, `CreateScrapeConfigPayload`,
 * `CreateAlertgroupsPayload`).
 */
const MAX_NAME_LENGTH = 200;

/**
 * Name prefix of the receivers `Stackit.Observability.AlertWebhook` creates. `AlertConfig`
 * writes the whole configuration, so it has to carry them along: they aren't its own.
 */
export const ALERT_WEBHOOK_RECEIVER_PREFIX = "alchemy-webhook-";

/** Room left for a generated name after the prefix, in a receiver name of at most 200. */
const MAX_WEBHOOK_NAME_LENGTH = MAX_NAME_LENGTH - ALERT_WEBHOOK_RECEIVER_PREFIX.length;

/** This generation's webhook receiver name, which only `AlertWebhook` uses. */
export const generatedWebhookReceiverName = (id: string) =>
  createPhysicalName({ id, lowercase: true, maxLength: MAX_WEBHOOK_NAME_LENGTH }).pipe(
    Effect.map((name) => `${ALERT_WEBHOOK_RECEIVER_PREFIX}${name}`),
  );

/** Whether a receiver name has the shape of a generated webhook receiver's, for nuke. */
export const isGeneratedWebhookReceiverName = (name: string) =>
  name.startsWith(ALERT_WEBHOOK_RECEIVER_PREFIX) &&
  isGeneratedPhysicalName(
    name.slice(ALERT_WEBHOOK_RECEIVER_PREFIX.length),
    MAX_WEBHOOK_NAME_LENGTH,
  );

/** A STACKIT project, which is all the Observability API scopes an instance to. */
export interface ObservabilityScope {
  projectId: string;
}

/** Where every object inside an instance lives. */
export interface InstanceScope extends ObservabilityScope {
  instanceId: string;
}

/**
 * This generation's generated name: a generation's instance id is in it, so it
 * proves the object is ours and can't collide with the generation it replaces.
 * The API only takes `a-zA-Z0-9-` in job, group and receiver names, which is what
 * `createPhysicalName` produces.
 */
export const generatedName = (id: string) =>
  createPhysicalName({ id, lowercase: true, maxLength: MAX_NAME_LENGTH });

/** Whether `name` has the shape of a generated name, for `alchemy unsafe nuke`. */
export const isGeneratedName = (name: string) => isGeneratedPhysicalName(name, MAX_NAME_LENGTH);

const alertConfigLock = makeKeyedLock();

/**
 * One lock per instance's Alertmanager configuration. `AlertConfig` reads and writes the
 * whole of it, and `AlertWebhook` writes parts of it, and neither depends on the other, so a
 * deploy runs them concurrently: a write between another's read and write would be lost, or
 * brought back. Hold it through the read-back too, so the next reader sees the write.
 */
export const withAlertConfigLock = (scope: InstanceScope) =>
  alertConfigLock(`${scope.projectId}/${scope.instanceId}`);

/** What the instance asked for doesn't exist, or its plan can't do it. */
export class ObservabilityConfigError extends Data.TaggedError(
  "Stackit.Observability.ConfigError",
)<{
  readonly instanceId: string | undefined;
  readonly message: string;
}> {}

/** No credential, group, job or check identity could be read back from a create. */
export class ObservabilityCreateError extends Data.TaggedError(
  "Stackit.Observability.CreateError",
)<{
  readonly resource: string;
  readonly message: string;
}> {}

/**
 * `GetInstance`; `undefined` when the instance is gone. A deleted instance keeps
 * answering with `DELETE_SUCCEEDED` for a while, which the Terraform provider also
 * treats as gone, so it counts the same as the typed `NotFound`.
 */
export const getInstanceOrUndefined = (scope: InstanceScope) =>
  observability.getInstance(scope).pipe(
    Effect.map((instance) => (instance.status === "DELETE_SUCCEEDED" ? undefined : instance)),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

/**
 * Whether the objects inside an instance are already gone with it, so a child's
 * read and delete can finish without asking. The spec documents no 404 on most
 * sub-resource paths, so what they answer for a deleted instance is unknown.
 */
export const isInstanceGone = (scope: InstanceScope) =>
  getInstanceOrUndefined(scope).pipe(
    Effect.map((instance) => instance === undefined || instance.status === "DELETING"),
  );

/** Live instances of a project with a generated name: the ones nuke may touch. */
export const listOwnedInstances = (projectId: string) =>
  observability
    .listInstances({ projectId })
    .pipe(
      Effect.map(({ instances }) =>
        instances.filter(
          (instance) =>
            instance.status !== "DELETE_SUCCEEDED" &&
            instance.name !== undefined &&
            isGeneratedName(instance.name),
        ),
      ),
    );

const UNITS: Readonly<Record<string, number>> = {
  ms: 0.001,
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
  y: 31536000,
};

/** A Prometheus duration (`90d`, `1h30m`, `60s`) in seconds; `undefined` when it isn't one. */
export const durationSeconds = (value: string): number | undefined => {
  if (!/^(\d+(\.\d+)?(ms|[smhdwy]))+$/.test(value)) return undefined;
  let seconds = 0;
  for (const [, amount, unit] of value.matchAll(/(\d+(?:\.\d+)?)(ms|[smhdwy])/g)) {
    seconds += Number(amount) * UNITS[unit!]!;
  }
  return seconds;
};

/** A retention in days, whatever unit the API answered in (`90d`, `168h`). */
export const retentionDays = (value: string): number | undefined => {
  const seconds = durationSeconds(value);
  return seconds === undefined ? undefined : seconds / 86400;
};

/**
 * Two durations mean the same. Alertmanager and Prometheus print durations in
 * their own way (`60s` comes back as `1m`), so text can't be compared.
 */
export const sameDuration = (a: string, b: string): boolean => {
  const left = durationSeconds(a);
  return left !== undefined && left === durationSeconds(b) ? true : a === b;
};

/** Members the API holds as durations. */
const DURATION_KEYS = new Set([
  "for",
  "groupInterval",
  "groupWait",
  "interval",
  "refreshInterval",
  "repeatInterval",
  "resolveTimeout",
  "scrapeInterval",
  "scrapeTimeout",
]);

/** String lists whose order changes what they mean. */
const ORDERED_LISTS = new Set(["sourceLabels"]);

/** Maps whose keys are all the user's, so a removed key has to count as drift. */
const EXACT_MAPS = new Set(["annotations", "labels", "params"]);

/** A list item's own identity, when it has one, so the API can reorder such a list. */
const identityOf = (item: unknown): string | undefined => {
  if (typeof item !== "object" || item === null) return undefined;
  const { name, alert, record, jobName } = item as Readonly<Record<string, unknown>>;
  const identity = name ?? alert ?? record ?? jobName;
  return typeof identity === "string" ? identity : undefined;
};

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isEmpty = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (Array.isArray(value) && value.length === 0) ||
  (isPlainObject(value) && Object.values(value).every((item) => item === undefined));

export interface MatchesOptions {
  /**
   * Don't compare secrets. A read-back must not wait on one, in case the API
   * ever masks it: the write has already been accepted.
   */
  readonly ignoreSecrets?: boolean;
}

/**
 * Whether what is live satisfies what was asked for. The API fills in defaults
 * (`sendResolved`, `honorLabels`, a relabel's `separator`) and rewrites durations,
 * so a plain comparison would report drift on every deploy:
 *
 * - a member `desired` doesn't set isn't compared, so build `desired` with `{}` or
 *   `[]` for the members a removal has to reach: those match only what is empty;
 * - `labels`, `annotations` and `params` match key for key, so a removed key counts;
 * - lists of named items are compared by name, other string lists as sets, and
 *   everything else by position (route order decides which receiver gets an alert);
 * - `false` and `""` match a missing member.
 */
export const matches = (
  desired: unknown,
  observed: unknown,
  options: MatchesOptions = {},
  key?: string,
): boolean => {
  if (desired === undefined) return true;
  if (Redacted.isRedacted(desired)) {
    return options.ignoreSecrets === true || secretsDiffer(desired, observed) === false;
  }
  if (typeof desired === "string" && key !== undefined && DURATION_KEYS.has(key)) {
    return sameDuration(desired, typeof observed === "string" ? observed : "0s");
  }
  if (desired === false || desired === "") {
    return observed === undefined || observed === null || observed === desired;
  }
  if (Array.isArray(desired)) {
    if (desired.length === 0) return isEmpty(observed);
    if (!Array.isArray(observed) || observed.length !== desired.length) return false;
    if (desired.every((item) => typeof item === "string") && !ORDERED_LISTS.has(key ?? "")) {
      const live = new Set(observed);
      return desired.every((item) => live.has(item));
    }
    if (desired.every((item) => identityOf(item) !== undefined)) {
      const live = new Map(observed.map((item) => [identityOf(item), item]));
      return desired.every((item) => matches(item, live.get(identityOf(item)), options, key));
    }
    return desired.every((item, index) => matches(item, observed[index], options, key));
  }
  if (isPlainObject(desired)) {
    const entries = Object.entries(desired).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return isEmpty(observed);
    if (!isPlainObject(observed)) return false;
    if (
      key !== undefined &&
      EXACT_MAPS.has(key) &&
      Object.values(observed).filter((value) => value !== undefined && value !== null).length !==
        entries.length
    ) {
      return false;
    }
    return entries.every(([member, value]) => matches(value, observed[member], options, member));
  }
  return desired === observed;
};

/**
 * Whether `news` leaves out something `olds` set, at any depth. {@link matches} can't see
 * that: a member `desired` doesn't set isn't compared. Use it to force the write when a prop
 * is removed. The read-back then skips that member, as what the API falls back to is its
 * own. Lists go by position, so a reordered one only costs a write.
 */
export const dropsMember = (olds: unknown, news: unknown): boolean => {
  if (Redacted.isRedacted(olds) || Redacted.isRedacted(news)) return false;
  if (Array.isArray(olds)) {
    return (
      Array.isArray(news) &&
      olds.some((item, index) => index < news.length && dropsMember(item, news[index]))
    );
  }
  if (!isPlainObject(olds) || !isPlainObject(news)) return false;
  return Object.entries(olds).some(
    ([member, value]) =>
      value !== undefined && (news[member] === undefined || dropsMember(value, news[member])),
  );
};

/** What an API answers in place of a secret: Alertmanager prints `<secret>`. */
const MASKED_SECRET = /^(<secret>|<redacted>|<hidden>|\[redacted\]|redacted|\*+)$/i;

const maskedSecretPaths = (value: unknown, path: string): string[] => {
  if (Redacted.isRedacted(value)) {
    const text = Redacted.value(value);
    return typeof text === "string" && MASKED_SECRET.test(text) ? [path] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => maskedSecretPaths(item, `${path}[${index}]`));
  }
  if (isPlainObject(value)) {
    return Object.entries(value).flatMap(([member, item]) =>
      maskedSecretPaths(item, path === "" ? member : `${path}.${member}`),
    );
  }
  return [];
};

/** A configuration read back holds a secret the API masked, and writing it back would keep the mask. */
export class ObservabilityMaskedSecret extends Data.TaggedError(
  "Stackit.Observability.MaskedSecret",
)<{
  readonly instanceId: string;
  /** Where the masks are. */
  readonly paths: ReadonlyArray<string>;
  readonly message: string;
}> {}

/**
 * Refuse to write back a secret that reads back masked. The API only takes whole blocks, so
 * what the props don't declare goes back as it was read. If a read gave a mask, that write
 * would replace the real secret for good, and read-backs ignore secrets, so it would look
 * like a success. Whether the API masks at all is unverified: see the catalog.
 */
export const assertNoMaskedSecrets = (
  instanceId: string,
  carried: unknown,
): Effect.Effect<void, ObservabilityMaskedSecret> => {
  const paths = maskedSecretPaths(carried, "");
  return paths.length === 0
    ? Effect.void
    : Effect.fail(
        new ObservabilityMaskedSecret({
          instanceId,
          paths,
          message: `STACKIT Observability instance ${instanceId} reads back ${paths.join(", ")} masked. Writing the configuration back would replace the real values with the mask, so nothing was written.`,
        }),
      );
};

/** Hand a secret on as `Redacted`, whichever way it was given. */
export const asRedacted = (
  value: string | Redacted.Redacted<string> | undefined,
): Redacted.Redacted<string> | undefined =>
  value === undefined || Redacted.isRedacted(value) ? value : Redacted.make(value);
