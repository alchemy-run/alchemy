import * as automation from "@distilled.cloud/azure/automation";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { createPhysicalName } from "../../PhysicalName.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/** Observe an Automation account; `undefined` when it does not exist. */
export const getAccount = (
  subscriptionId: string,
  resourceGroupName: string,
  automationAccountName: string,
) =>
  orUndefinedIfNotFound(
    automation.GetAutomationAccount({
      subscriptionId,
      resourceGroupName,
      automationAccountName,
    }),
  );

/**
 * Untagged children of an Automation account (schedules, variables,
 * credentials, ...) count as owned when their parent account carries this
 * stack's and stage's ownership tags.
 */
export const accountOwnedByStage = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  automationAccountName: string,
) {
  const observed = yield* getAccount(
    subscriptionId,
    resourceGroupName,
    automationAccountName,
  );
  const { stack, stage } = yield* stackAndStage;
  return (
    observed?.tags?.["alchemy::stack"] === stack &&
    observed?.tags?.["alchemy::stage"] === stage
  );
});

/**
 * Automation account name: 6-50 letters, digits, and hyphens, starting with
 * a letter and ending with a letter or digit.
 */
export const createAccountName = Effect.fn(function* (id: string) {
  const name = (yield* createPhysicalName({ id, maxLength: 50 }))
    .replace(/-{2,}/g, "-")
    .replace(/-+$/, "");
  return /^[a-zA-Z]/.test(name) ? name : `a${name.slice(1)}`;
});

/**
 * Name of an account child (runbook, schedule, variable, ...): letters,
 * digits, hyphens, and underscores, starting with a letter. Runbook names
 * are the tightest constraint (63 characters).
 */
export const createChildName = Effect.fn(function* (
  id: string,
  maxLength = 63,
) {
  const name = (yield* createPhysicalName({ id, maxLength }))
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+$/, "");
  return /^[a-zA-Z]/.test(name) ? name : `r${name.slice(1)}`;
});

/** Case-insensitive equality for Azure names. */
export const sameName = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/** Shallow string-map equality (undefined treated as empty). */
export const sameRecord = (
  a: Record<string, string | undefined> | undefined,
  b: Record<string, string | undefined> | undefined,
) => {
  const left = Object.entries(a ?? {}).filter(([, v]) => v !== undefined);
  const right = Object.entries(b ?? {}).filter(([, v]) => v !== undefined);
  return (
    left.length === right.length &&
    left.every(([k, v]) => (b ?? {})[k] === v)
  );
};

/** Nuke ordering shared by every account child. */
export const childNuke = {
  dependsOn: [
    "Azure.Automation.AutomationAccount",
    "Azure.Resources.ResourceGroup",
  ],
};

/** Plain value of a secret prop (state may hold it unwrapped). */
export const reveal = (value: unknown): unknown =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

/** Text equality where empty and absent are the same. */
export const sameText = (a: string | null | undefined, b: string | null | undefined) =>
  (a || undefined) === (b || undefined);
