import * as synapse from "@distilled.cloud/azure/synapse";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { createHash } from "node:crypto";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import {
  orUndefinedIfNotFound,
  stackAndStage,
  waitForProvisioned,
} from "../Arm.ts";

export const lower = (value: string | undefined) => value?.toLowerCase();

export const sameId = (a: string | undefined, b: string | undefined) =>
  lower(a) === lower(b);

/**
 * Generate a lowercase name of letters, digits, and single hyphens that
 * starts and ends with a letter or digit (workspaces, Private Link Hubs).
 */
export const createDnsName = Effect.fn(function* (
  id: string,
  maxLength: number,
  delimiter = "-",
) {
  const name = yield* createPhysicalName({
    id,
    maxLength,
    lowercase: true,
    delimiter,
  });
  return name
    .replace(/[^a-z0-9-]/g, delimiter)
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
});

/**
 * Generate a name of letters and digits only, starting with a letter
 * (Spark pools: at most 15 characters).
 */
export const createAlnumName = Effect.fn(function* (
  id: string,
  maxLength: number,
) {
  const name = yield* createPhysicalName({
    id,
    maxLength,
    delimiter: "",
    suffixLength: 6,
  });
  const alnum = name.replace(/[^a-zA-Z0-9]/g, "");
  return /^[a-zA-Z]/.test(alnum) ? alnum : `p${alnum.slice(0, maxLength - 1)}`;
});

/** Generate a child resource name (letters, digits, hyphens, underscores). */
export const createChildName = (id: string, maxLength = 80) =>
  createPhysicalName({ id, maxLength });

/**
 * Salted SHA-256 fingerprint of a write-only secret (e.g. the SQL
 * administrator password), so a change can be detected without persisting
 * the secret.
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

/**
 * Whether every defined field of `desired` is reflected in `observed`
 * (strings compared case-insensitively, arrays as sorted sets, objects as
 * subsets).
 */
export const fieldsMatch = (observed: unknown, desired: unknown): boolean => {
  if (desired === undefined) return true;
  if (typeof desired === "string") {
    return typeof observed === "string" && lower(observed) === lower(desired);
  }
  if (Array.isArray(desired)) {
    if (!Array.isArray(observed) || observed.length !== desired.length) {
      return false;
    }
    const norm = (values: unknown[]) =>
      values
        .map((v) =>
          typeof v === "string" ? v.toLowerCase() : JSON.stringify(v),
        )
        .sort()
        .join("\u0000");
    return norm(observed) === norm(desired);
  }
  if (typeof desired === "object" && desired !== null) {
    if (typeof observed !== "object" || observed === null) return false;
    return Object.entries(desired).every(([key, value]) =>
      fieldsMatch((observed as Record<string, unknown>)[key], value),
    );
  }
  return observed === desired;
};

export const getWorkspace = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
) =>
  orUndefinedIfNotFound(
    synapse.GetWorkspace({ subscriptionId, resourceGroupName, workspaceName }),
  );

/**
 * Whether the workspace is tagged as owned by the current stack and stage.
 * Workspace settings and children that cannot carry tags inherit ownership
 * from their workspace.
 */
export const isWorkspaceOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
) {
  const workspace = yield* getWorkspace(
    subscriptionId,
    resourceGroupName,
    workspaceName,
  );
  if (workspace === undefined) return false;
  const { stack, stage } = yield* stackAndStage;
  const tags = tagRecord(workspace.tags);
  return tags["alchemy::stack"] === stack && tags["alchemy::stage"] === stage;
});

/**
 * Location of a workspace child: the explicit location, else the parent
 * workspace's location (children must live with their workspace).
 */
export const workspaceLocation = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  explicit: string | undefined,
  fallback: string,
) {
  if (explicit !== undefined) return explicit;
  const workspace = yield* getWorkspace(
    subscriptionId,
    resourceGroupName,
    workspaceName,
  );
  return workspace?.location ?? fallback;
});

export const getSqlPool = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  sqlPoolName: string,
) =>
  orUndefinedIfNotFound(
    synapse.GetSqlPool({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      sqlPoolName,
    }),
  );

/** An `Enabled`/`Disabled` setting state. */
export type SynapseEnabledState = "Enabled" | "Disabled";

/**
 * Converge an always-present singleton setting (auditing, TLS, alert
 * policies, ...): observe it, PUT the desired value only when the observed
 * value differs, then wait until GET reflects it.
 */
export const syncSetting = <O, E1, R1, E2, R2>(options: {
  readonly label: string;
  readonly get: Effect.Effect<O | undefined, E1, R1>;
  readonly matches: (observed: O) => boolean;
  readonly put: Effect.Effect<unknown, E2, R2>;
}) =>
  Effect.gen(function* () {
    const observed = yield* options.get;
    if (observed === undefined || !options.matches(observed)) {
      yield* options.put;
    }
    return yield* waitForProvisioned(
      options.label,
      options.get,
      (value) => (options.matches(value) ? "Succeeded" : "Updating"),
      { interval: "5 seconds", times: 60 },
    );
  });

/**
 * Reset a singleton setting during delete. A setting whose parent is
 * already gone (`get` yields `undefined`) needs no reset.
 */
export const resetSetting = <O, E1, R1, E2, R2>(options: {
  readonly label: string;
  readonly get: Effect.Effect<O | undefined, E1, R1>;
  readonly matches: (observed: O) => boolean;
  readonly put: Effect.Effect<unknown, E2, R2>;
}) =>
  Effect.gen(function* () {
    const observed = yield* options.get;
    if (observed === undefined || options.matches(observed)) return;
    yield* syncSetting(options);
  });

/** Blob auditing settings shared by workspace and SQL pool auditing. */
export interface AuditingSettingFields {
  /**
   * Whether auditing is enabled.
   * @default "Enabled"
   */
  state?: SynapseEnabledState;
  /**
   * Blob endpoint of the audit storage account, e.g.
   * `https://{account}.blob.core.windows.net`. Required for storage
   * auditing unless `isAzureMonitorTargetEnabled` is set.
   */
  storageEndpoint?: string;
  /**
   * Access key of the audit storage account. Write-only: Azure never
   * returns it. Omit it to authenticate with the workspace managed
   * identity.
   */
  storageAccountAccessKey?: Redacted.Redacted<string>;
  /** Subscription of the audit storage account. */
  storageAccountSubscriptionId?: string;
  /** Whether `storageAccountAccessKey` is the account's secondary key. */
  isStorageSecondaryKeyInUse?: boolean;
  /** Days to keep audit logs in storage (0 = unlimited). */
  retentionDays?: number;
  /**
   * Action groups and actions to audit, e.g.
   * `["BATCH_COMPLETED_GROUP", "SUCCESSFUL_DATABASE_AUTHENTICATION_GROUP"]`.
   * @default Azure's default set
   */
  auditActionsAndGroups?: string[];
  /**
   * Send audit events to Azure Monitor (configure a diagnostic setting
   * with the `SQLSecurityAuditEvents` category on the target).
   */
  isAzureMonitorTargetEnabled?: boolean;
  /** Milliseconds before audit actions are forced to be processed. */
  queueDelayMs?: number;
}

/** Wire properties of a blob auditing policy (without the secret). */
export const auditingProperties = (fields: AuditingSettingFields) => ({
  state: fields.state ?? "Enabled",
  storageEndpoint: fields.storageEndpoint,
  storageAccountSubscriptionId: fields.storageAccountSubscriptionId,
  isStorageSecondaryKeyInUse: fields.isStorageSecondaryKeyInUse,
  retentionDays: fields.retentionDays,
  auditActionsAndGroups: fields.auditActionsAndGroups,
  isAzureMonitorTargetEnabled: fields.isAzureMonitorTargetEnabled,
  queueDelayMs: fields.queueDelayMs,
});

/** The secret, unwrapped for the wire. */
export const unwrapSecret = (secret: Redacted.Redacted<string> | undefined) =>
  secret === undefined ? undefined : Redacted.value(secret);

/** Threat detection settings shared by workspace and SQL pool policies. */
export interface SecurityAlertPolicyFields {
  /**
   * Whether threat detection (Microsoft Defender for SQL alerts) is on.
   * @default "Enabled"
   */
  state?: SynapseEnabledState;
  /**
   * Alerts to suppress, e.g. `Sql_Injection`, `Sql_Injection_Vulnerability`,
   * `Access_Anomaly`, `Data_Exfiltration`, `Unsafe_Action`.
   */
  disabledAlerts?: string[];
  /** Email addresses that receive alerts. */
  emailAddresses?: string[];
  /** Also email the subscription administrators. */
  emailAccountAdmins?: boolean;
  /** Blob endpoint of a storage account that keeps threat detection logs. */
  storageEndpoint?: string;
  /** Access key of that storage account. Write-only. */
  storageAccountAccessKey?: Redacted.Redacted<string>;
  /** Days to keep threat detection logs. */
  retentionDays?: number;
}

/** Wire properties of a security alert policy (without the secret). */
export const securityAlertProperties = (fields: SecurityAlertPolicyFields) => ({
  state: fields.state ?? "Enabled",
  disabledAlerts: fields.disabledAlerts,
  emailAddresses: fields.emailAddresses,
  emailAccountAdmins: fields.emailAccountAdmins,
  storageEndpoint: fields.storageEndpoint,
  retentionDays: fields.retentionDays,
});

/** Vulnerability assessment settings shared by workspaces and SQL pools. */
export interface VulnerabilityAssessmentFields {
  /**
   * Blob container URL for scan results, e.g.
   * `https://{account}.blob.core.windows.net/vulnerability-assessment`.
   */
  storageContainerPath: string;
  /** SAS token with write access to the container. Write-only. */
  storageContainerSasKey?: Redacted.Redacted<string>;
  /** Access key of the storage account. Write-only. */
  storageAccountAccessKey?: Redacted.Redacted<string>;
  /** Recurring (weekly) scans. */
  recurringScans?: {
    /** Whether recurring scans are enabled. */
    isEnabled?: boolean;
    /** Email scan reports to the subscription administrators. */
    emailSubscriptionAdmins?: boolean;
    /** Email addresses that receive scan reports. */
    emails?: string[];
  };
}

/** Props locating a child of a dedicated SQL pool. */
export interface SqlPoolChildProps {
  /** Resource group of the workspace. Changing it replaces the resource. */
  resourceGroup: string;
  /** Name of the Synapse workspace. Changing it replaces the resource. */
  workspace: string;
  /** Name of the dedicated SQL pool. Changing it replaces the resource. */
  sqlPool: string;
}

/** Attributes locating a child of a dedicated SQL pool. */
export interface SqlPoolChildAttrs {
  /** Name of the workspace. */
  workspaceName: string;
  /** Resource group of the workspace. */
  resourceGroup: string;
  /** Name of the dedicated SQL pool. */
  sqlPoolName: string;
}

/** Whether a SQL pool child moved to another pool (replacement). */
export const sqlPoolChildMoved = (
  news: SqlPoolChildProps,
  output: SqlPoolChildAttrs,
) =>
  lower(news.resourceGroup) !== lower(output.resourceGroup) ||
  lower(news.workspace) !== lower(output.workspaceName) ||
  lower(news.sqlPool) !== lower(output.sqlPoolName);

/** Location of a SQL pool child, from `output` or else `olds`. */
export const sqlPoolChildRef = (
  olds: SqlPoolChildProps | undefined,
  output: SqlPoolChildAttrs | undefined,
) => {
  const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
  const workspaceName = output?.workspaceName ?? olds?.workspace;
  const sqlPoolName = output?.sqlPoolName ?? olds?.sqlPool;
  return resourceGroup === undefined ||
    workspaceName === undefined ||
    sqlPoolName === undefined
    ? undefined
    : { resourceGroup, workspaceName, sqlPoolName };
};

/** ARM path parameters of a SQL pool child. */
export const sqlPoolWhere = (
  subscriptionId: string,
  ref: SqlPoolChildAttrs,
) => ({
  subscriptionId,
  resourceGroupName: ref.resourceGroup,
  workspaceName: ref.workspaceName,
  sqlPoolName: ref.sqlPoolName,
});
