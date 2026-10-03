import type * as servicelinker from "@distilled.cloud/azure/servicelinker";
import * as Redacted from "effect/Redacted";

/** The target of a Service Connector connection. */
export type ConnectionTargetService =
  | {
      /** An Azure resource (Storage, Key Vault, SQL, Cosmos DB, Service Bus, ...). */
      type: "AzureResource";
      /** ARM resource ID of the target, e.g. a storage account's blob service. */
      id: string;
      /**
       * Extra target properties, discriminated by their own `type`, e.g.
       * `{ type: "KeyVault", connectAsKubernetesCsiDriver: true }`.
       */
      resourceProperties?: Record<string, unknown>;
    }
  | {
      /** A server outside Azure Resource Manager. */
      type:
        | "ConfluentBootstrapServer"
        | "ConfluentSchemaRegistry"
        | "SelfHostedServer";
      /** Endpoint of the server. */
      endpoint: string;
    };

/** Password or Key Vault secret for `secret` auth. */
export type ConnectionSecretInfo =
  | {
      /** A raw secret value. Omit `value` to let Service Connector fetch it from the target. */
      secretType: "rawValue";
      /** The secret value. */
      value?: Redacted.Redacted<string>;
    }
  | {
      /** A secret already stored in the Key Vault of `secretStore`. */
      secretType: "keyVaultSecretReference";
      /** Name of the Key Vault secret. */
      name: string;
      /** Version of the Key Vault secret. */
      version?: string;
    }
  | {
      /** A Key Vault secret URI. */
      secretType: "keyVaultSecretUri";
      /** URI of the Key Vault secret. */
      value: string;
    };

/** How the source authenticates to the target. */
export interface ConnectionAuthInfo {
  /** Authentication type. */
  authType:
    | "systemAssignedIdentity"
    | "userAssignedIdentity"
    | "servicePrincipalSecret"
    | "servicePrincipalCertificate"
    | "secret"
    | "accessKey"
    | "userAccount"
    | "easyAuthMicrosoftEntraID";
  /**
   * `optInAllAuth` lets Service Connector enable identities and grant RBAC
   * roles; `optOutAllAuth` skips that setup.
   * @default "optInAllAuth"
   */
  authMode?: "optInAllAuth" | "optOutAllAuth";
  /** Database user mapped to the identity (identity, userAccount, servicePrincipal* types). */
  userName?: string;
  /** Whether to clean up the auth setup (role assignments, ...) on update or delete. */
  deleteOrUpdateBehavior?: "Default" | "ForcedCleanup";
  /** RBAC role names to grant on the target instead of the defaults. */
  roles?: string[];
  /** Client ID of the user-assigned identity or service principal. */
  clientId?: string;
  /** Subscription of the user-assigned identity. */
  subscriptionId?: string;
  /** Principal ID of the service principal or user. */
  principalId?: string;
  /** Service principal secret (`servicePrincipalSecret`). */
  secret?: Redacted.Redacted<string>;
  /** Service principal certificate (`servicePrincipalCertificate`). */
  certificate?: Redacted.Redacted<string>;
  /** User or account name (`secret`). */
  name?: string;
  /** Password or Key Vault secret (`secret`). */
  secretInfo?: ConnectionSecretInfo;
  /** Access-key permissions (`accessKey`), e.g. `["Listen", "Send"]`. */
  permissions?: string[];
}

/** Client library the generated configuration names target. */
export type ConnectionClientType =
  | "none"
  | "dotnet"
  | "java"
  | "python"
  | "go"
  | "php"
  | "ruby"
  | "django"
  | "nodejs"
  | "springBoot"
  | "kafka-springBoot"
  | "jms-springBoot"
  | "dapr";

/** Properties shared by `Linker` and `Connector`. */
export interface ConnectionProps {
  /** The target service. Changing it replaces the connection. */
  targetService: ConnectionTargetService;
  /** How the source authenticates to the target. */
  authInfo: ConnectionAuthInfo;
  /**
   * Client library; decides the generated configuration names (e.g.
   * `AZURE_STORAGEBLOB_CONNECTIONSTRING`).
   * @default "none"
   */
  clientType?: ConnectionClientType;
  /** Reach the target over a service endpoint or private link. */
  vNetSolution?: {
    /** VNet solution type. */
    type?: "serviceEndpoint" | "privateLink";
    /** Whether to clean up the VNet setup on update or delete. */
    deleteOrUpdateBehavior?: "Default" | "ForcedCleanup";
  };
  /** Store generated secrets in a Key Vault instead of plain app settings. */
  secretStore?: {
    /** ARM ID of the Key Vault. */
    keyVaultId?: string;
    /** Secret name; only valid when one secret is stored. */
    keyVaultSecretName?: string;
  };
  /** Connection scope in the source, e.g. the container name of a Container App. */
  scope?: string;
  /** Firewall setup on the target to admit the source. */
  publicNetworkSolution?: {
    /** Whether to clean up firewall rules on update or delete. */
    deleteOrUpdateBehavior?: "Default" | "ForcedCleanup";
    /** `enable` (default) configures public network access; `optOut` skips it. */
    action?: "enable" | "optOut";
    /** Firewall rules to add on the target. */
    firewallRules?: {
      /** IP ranges in CIDR form. */
      ipRanges?: string[];
      /** Allow Azure services. */
      azureServices?: "true" | "false";
      /** Allow the caller's client IP. */
      callerClientIP?: "true" | "false";
    };
  };
  /** How generated configuration is applied to the source. */
  configurationInfo?: {
    /** Whether to remove generated configuration on update or delete. */
    deleteOrUpdateBehavior?: "Default" | "ForcedCleanup";
    /** `enable` (default) writes configuration to the source; `optOut` does not. */
    action?: "enable" | "optOut";
    /** Map of default configuration names to custom names. */
    customizedKeys?: Record<string, string>;
    /** Extra configurations to add. */
    additionalConfigurations?: Record<string, string>;
    /** Extra properties appended to the connection string. */
    additionalConnectionStringProperties?: Record<string, string>;
    /** Store configuration in an App Configuration store. */
    configurationStore?: {
      /** ARM ID of the App Configuration store. */
      appConfigurationId?: string;
    };
  };
}

/** The request body for a linker/connector PUT. */
export const toLinkerInput = (
  props: ConnectionProps,
): servicelinker.LinkerPropertiesInput => ({
  targetService: props.targetService,
  authInfo: props.authInfo,
  clientType: props.clientType ?? "none",
  vNetSolution: props.vNetSolution,
  secretStore: props.secretStore,
  scope: props.scope,
  publicNetworkSolution: props.publicNetworkSolution,
  configurationInfo: props.configurationInfo,
});

const canonical = (value: unknown): unknown => {
  if (Redacted.isRedacted(value)) return Redacted.value(value);
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
};

/**
 * Whether two prop sets would send different request bodies. Secrets and
 * most inputs are not echoed by GET, so the previous props are the only
 * baseline for them.
 */
export const connectionPropsDiffer = (a: ConnectionProps, b: ConnectionProps) =>
  JSON.stringify(canonical(toLinkerInput(a))) !==
  JSON.stringify(canonical(toLinkerInput(b)));

/**
 * Whether the observed connection disagrees with the desired props on the
 * fields the API echoes back.
 */
export const observedDiffers = (
  observed: servicelinker.LinkerProperties | undefined,
  desired: ConnectionProps,
) => {
  if (observed === undefined) return true;
  const target = observed.targetService;
  const desiredTarget = desired.targetService;
  const targetKey =
    desiredTarget.type === "AzureResource"
      ? desiredTarget.id
      : desiredTarget.endpoint;
  const observedKey =
    desiredTarget.type === "AzureResource" ? target?.id : target?.endpoint;
  return (
    (target?.type ?? "") !== desiredTarget.type ||
    (observedKey ?? "").toLowerCase() !== targetKey.toLowerCase() ||
    (observed.authInfo?.authType ?? "") !== desired.authInfo.authType ||
    (observed.clientType ?? "none") !== (desired.clientType ?? "none") ||
    (observed.scope ?? undefined) !== desired.scope ||
    (observed.vNetSolution?.type ?? undefined) !== desired.vNetSolution?.type ||
    (observed.secretStore?.keyVaultId ?? undefined)?.toLowerCase() !==
      desired.secretStore?.keyVaultId?.toLowerCase()
  );
};

/** Whether the target changed in a way that makes a new connection. */
export const targetChanged = (
  a: ConnectionTargetService,
  b: ConnectionTargetService,
) =>
  a.type !== b.type ||
  (a.type === "AzureResource" && b.type === "AzureResource"
    ? a.id.toLowerCase() !== b.id.toLowerCase()
    : a.type !== "AzureResource" &&
      b.type !== "AzureResource" &&
      a.endpoint !== b.endpoint);
