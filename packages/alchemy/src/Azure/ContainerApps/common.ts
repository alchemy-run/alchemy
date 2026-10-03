import * as app from "@distilled.cloud/azure/app";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/** Lowercase an optional string, for case-insensitive ARM comparisons. */
export const lower = (value: string | undefined) => value?.toLowerCase();

/** Compare Azure locations, ignoring case and spaces (`East US` = `eastus`). */
export const sameLocation = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase().replaceAll(" ", "") === b?.toLowerCase().replaceAll(" ", "");

/** Unwrap a secret prop that may be given as plain text or `Redacted`. */
export const reveal = (
  value: string | Redacted.Redacted<string> | undefined,
) =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? Redacted.value(value)
      : value;

/**
 * Whether the observed JSON value satisfies the desired one. Objects match
 * when every desired key matches (Azure echoes extra defaults back), arrays
 * element-wise, strings case-insensitively (ARM normalizes casing).
 */
export const matchesDesired = (
  desired: unknown,
  observed: unknown,
): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      observed.length === desired.length &&
      desired.every((item, i) => matchesDesired(item, observed[i]))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    const record = observed as Record<string, unknown>;
    return Object.entries(desired as Record<string, unknown>).every(
      ([key, value]) => matchesDesired(value, record[key]),
    );
  }
  if (typeof desired === "string" && typeof observed === "string") {
    return desired.toLowerCase() === observed.toLowerCase();
  }
  return desired === observed;
};

/**
 * Canonical JSON of a request body, used to compare the previous and the
 * desired body. ARM never echoes secrets back, so a changed secret (or a
 * removed property, which `matchesDesired` cannot see) is only visible here.
 */
export const fingerprint = (value: unknown) =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : v,
  );

/**
 * Deterministic Container Apps name: lowercase letters, digits, and single
 * hyphens, starting with a letter and ending with a letter or digit.
 */
export const createContainerAppsName = Effect.fn(function* (
  id: string,
  maxLength: number,
) {
  const name = yield* createPhysicalName({ id, maxLength, lowercase: true });
  const cleaned = name
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return /^[a-z]/.test(cleaned)
    ? cleaned
    : `a${cleaned}`.slice(0, maxLength).replace(/-+$/, "");
});

/** Managed identity of a Container Apps resource. */
export interface ContainerAppsIdentity {
  /** Identity type. */
  type:
    | "None"
    | "SystemAssigned"
    | "UserAssigned"
    | "SystemAssigned,UserAssigned";
  /** ARM IDs of the user-assigned identities to attach. */
  userAssignedIdentities?: string[];
}

/** The wire shape of a managed identity. */
export const toIdentity = (
  identity: ContainerAppsIdentity | undefined,
): app.ContainerAppsCreateOrUpdateRequestIdentity | undefined =>
  identity === undefined
    ? undefined
    : {
        type: identity.type,
        userAssignedIdentities:
          identity.userAssignedIdentities !== undefined &&
          identity.userAssignedIdentities.length > 0
            ? Object.fromEntries(
                identity.userAssignedIdentities.map((id) => [id, {}]),
              )
            : undefined,
      };

const normalizeType = (type: string | undefined) =>
  (type ?? "None").toLowerCase().replaceAll(" ", "");

/** Whether the observed identity matches the desired one. */
export const identityMatches = (
  desired: ContainerAppsIdentity | undefined,
  observed:
    | {
        readonly type?: string;
        readonly userAssignedIdentities?: Record<string, unknown>;
      }
    | undefined,
) => {
  if (desired === undefined) return true;
  if (normalizeType(desired.type) !== normalizeType(observed?.type)) {
    return false;
  }
  const want = (desired.userAssignedIdentities ?? [])
    .map((id) => id.toLowerCase())
    .sort();
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  return want.join("|") === have.join("|");
};

/** A secret stored on a container app, job, or session pool. */
export interface ContainerAppsSecret {
  /** Secret name, referenced by `secretRef` in env vars and registries. */
  name: string;
  /** Secret value. Omit when `keyVaultUrl` is set. */
  value?: string | Redacted.Redacted<string>;
  /** Key Vault secret URL to reference instead of an inline value. */
  keyVaultUrl?: string;
  /** Managed identity (ARM ID or `system`) used to read `keyVaultUrl`. */
  identity?: string;
}

/** The wire shape of secrets (values revealed). */
export const toSecrets = (
  secrets: ReadonlyArray<ContainerAppsSecret> | undefined,
): app.Secret[] =>
  (secrets ?? []).map((secret) => ({
    name: secret.name,
    value: reveal(secret.value),
    keyVaultUrl: secret.keyVaultUrl,
    identity: secret.identity,
  }));

/**
 * Whether the observed secrets (from a `listSecrets` call, values included)
 * match the desired secrets, ignoring order.
 */
export const secretsMatch = (
  desired: ReadonlyArray<app.Secret>,
  observed: ReadonlyArray<app.Secret> | undefined,
) => {
  const key = (secrets: ReadonlyArray<app.Secret>) =>
    secrets
      .map((s) =>
        JSON.stringify([
          s.name ?? "",
          s.keyVaultUrl ? "" : (s.value ?? ""),
          lower(s.keyVaultUrl) ?? "",
        ]),
      )
      .sort()
      .join("\n");
  return key(desired) === key(observed ?? []);
};

/** Read a managed environment, `undefined` when missing. */
export const getEnvironment = (
  subscriptionId: string,
  resourceGroupName: string,
  environmentName: string,
) =>
  orUndefinedIfNotFound(
    app.GetManagedEnvironment({
      subscriptionId,
      resourceGroupName,
      environmentName,
    }),
  );

/** Read a container app, `undefined` when missing. */
export const getContainerApp = (
  subscriptionId: string,
  resourceGroupName: string,
  containerAppName: string,
) =>
  orUndefinedIfNotFound(
    app.GetContainerApp({
      subscriptionId,
      resourceGroupName,
      containerAppName,
    }),
  );

/** Whether tags carry the current stack and stage. */
export const taggedByStack = Effect.fn(function* (
  tags: Record<string, string | undefined> | undefined,
) {
  const { stack, stage } = yield* stackAndStage;
  const record = tagRecord(tags);
  return (
    record["alchemy::stack"] === stack && record["alchemy::stage"] === stage
  );
});

/**
 * Whether the managed environment is tagged as owned by the current stack
 * and stage. Untagged environment children (storages, Dapr components)
 * inherit ownership from it.
 */
export const isEnvironmentOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  environmentName: string,
) {
  const env = yield* getEnvironment(
    subscriptionId,
    resourceGroupName,
    environmentName,
  );
  return env !== undefined && (yield* taggedByStack(env.tags));
});

/**
 * Whether the container app is tagged as owned by the current stack and
 * stage. Untagged app children (auth configs) inherit ownership from it.
 */
export const isContainerAppOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  containerAppName: string,
) {
  const containerApp = yield* getContainerApp(
    subscriptionId,
    resourceGroupName,
    containerAppName,
  );
  return (
    containerApp !== undefined && (yield* taggedByStack(containerApp.tags))
  );
});

/** Name segment of an ARM resource ID. */
export const nameOf = (armId: string | undefined) =>
  armId
    ?.split("/")
    .filter((part) => part.length > 0)
    .pop();

/** Read a connected environment, `undefined` when missing. */
export const getConnectedEnvironment = (
  subscriptionId: string,
  resourceGroupName: string,
  connectedEnvironmentName: string,
) =>
  orUndefinedIfNotFound(
    app.GetConnectedEnvironment({
      subscriptionId,
      resourceGroupName,
      connectedEnvironmentName,
    }),
  );

/**
 * Whether the connected environment is tagged as owned by the current
 * stack and stage. Untagged children (storages, Dapr components) inherit
 * ownership from it.
 */
export const isConnectedEnvironmentOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  connectedEnvironmentName: string,
) {
  const env = yield* getConnectedEnvironment(
    subscriptionId,
    resourceGroupName,
    connectedEnvironmentName,
  );
  return env !== undefined && (yield* taggedByStack(env.tags));
});
