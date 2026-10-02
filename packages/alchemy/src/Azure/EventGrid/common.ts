import type * as eventgrid from "@distilled.cloud/azure/eventgrid";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { createPhysicalName } from "../../PhysicalName.ts";
import type { JsonInputSchemaMapping } from "./Topic.ts";

/** Managed identity type of an Event Grid resource. */
export type EventGridIdentityType =
  | "None"
  | "SystemAssigned"
  | "UserAssigned"
  | "SystemAssigned, UserAssigned";

/** Managed identity of an Event Grid topic, domain, namespace, or system topic. */
export interface EventGridIdentity {
  /** Identity type. `None` removes any identity. */
  type: EventGridIdentityType;
  /**
   * ARM IDs of user-assigned identities, e.g. `identity.identityId` of an
   * `Azure.ManagedIdentity.UserAssignedIdentity`.
   */
  userAssignedIdentities?: string[];
}

/** An inbound IP rule that allows publishing from a CIDR range. */
export interface EventGridInboundIpRule {
  /** IP address range in CIDR notation, e.g. `10.0.0.0/8`. */
  ipMask: string;
  /** Action for matching traffic. @default "Allow" */
  action?: "Allow";
}

const lower = (value: string) => value.toLowerCase();
const normalizeType = (value: string | undefined) =>
  (value ?? "None").replace(/\s/g, "").toLowerCase();

/** Desired identity in wire form. */
export const toIdentityInfo = (
  identity: EventGridIdentity | undefined,
): eventgrid.IdentityInfo | undefined =>
  identity === undefined
    ? undefined
    : {
        type: identity.type,
        userAssignedIdentities: identity.userAssignedIdentities?.length
          ? Object.fromEntries(
              identity.userAssignedIdentities.map((id) => [id, {}]),
            )
          : undefined,
      };

/** Whether the observed identity differs from the desired one (unset = unmanaged). */
export const identityDiffers = (
  observed: eventgrid.IdentityInfo | undefined,
  desired: EventGridIdentity | undefined,
) => {
  if (desired === undefined) return false;
  if (normalizeType(observed?.type) !== normalizeType(desired.type)) {
    return true;
  }
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map(lower)
    .sort();
  const want = (desired.userAssignedIdentities ?? []).map(lower).sort();
  return JSON.stringify(have) !== JSON.stringify(want);
};

/** Desired inbound IP rules in wire form. */
export const toIpRules = (rules: EventGridInboundIpRule[] | undefined) =>
  (rules ?? []).map((rule) => ({
    ipMask: rule.ipMask,
    action: rule.action ?? "Allow",
  }));

/** Whether observed inbound IP rules differ from the desired ones. */
export const ipRulesDiffer = (
  observed: readonly eventgrid.InboundIpRule[] | undefined,
  desired: readonly { ipMask: string; action: string }[],
) => {
  const key = (rules: readonly { ipMask?: string; action?: string }[]) =>
    rules
      .map((rule) => `${rule.ipMask ?? ""}|${rule.action ?? "Allow"}`)
      .sort()
      .join(",");
  return key(observed ?? []) !== key(desired);
};

/**
 * Physical name for Event Grid resources: letters, digits, and hyphens
 * (topics, domains, namespaces, and subscriptions share this rule).
 */
export const createEventGridName = Effect.fn(function* (
  id: string,
  maxLength: number,
) {
  const name = yield* createPhysicalName({ id, maxLength });
  return name.replace(/[^A-Za-z0-9-]/g, "-");
});

/** Shared access keys as redacted attributes. */
export const redactKeys = (
  keys: { key1?: string; key2?: string } | undefined,
) => ({
  primaryKey: keys?.key1 === undefined ? undefined : Redacted.make(keys.key1),
  secondaryKey: keys?.key2 === undefined ? undefined : Redacted.make(keys.key2),
});

/** Case-insensitive equality for Azure names and locations. */
export const sameName = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase().replace(/\s/g, "") === b?.toLowerCase().replace(/\s/g, "");

/** Assign `key` on `target` when the desired value is set and differs. */
export const setIfChanged = <T extends object, K extends keyof T>(
  target: Partial<T>,
  key: K,
  desired: T[K] | undefined,
  observed: unknown,
) => {
  if (desired !== undefined && desired !== observed) target[key] = desired;
};

/** Wire form of a JSON input schema mapping. */
export const toInputSchemaMapping = (
  mapping: JsonInputSchemaMapping | undefined,
) =>
  mapping === undefined
    ? undefined
    : { inputSchemaMappingType: "Json", properties: mapping };
