import type * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { ownershipMarkers, sameValue, withoutMarkers } from "./Common.ts";

export type ConnectionAuthType = cognitiveservices.ConnectionAuthType;
export type ConnectionCategory = cognitiveservices.ConnectionCategory;

type Secret = string | Redacted.Redacted<string>;

/**
 * Write-only credentials of a connection; which fields apply depends on
 * `authType`. Azure never returns them, so Alchemy tracks a hash in the
 * connection metadata to detect changes.
 */
export interface ConnectionCredentials {
  /** API key (`ApiKey`). */
  key?: Secret;
  /** Named keys (`CustomKeys`), e.g. `{ "x-api-key": "..." }`. */
  keys?: Record<string, Secret>;
  /** Client ID (`ServicePrincipal`, `OAuth2`). */
  clientId?: string;
  /** Client secret (`ServicePrincipal`, `OAuth2`). */
  clientSecret?: Secret;
  /** Tenant ID (`ServicePrincipal`). */
  tenantId?: string;
  /** User name (`UsernamePassword`). */
  username?: string;
  /** Password (`UsernamePassword`). */
  password?: Secret;
  /** Personal access token (`PAT`). */
  pat?: Secret;
  /** SAS token (`SAS`). */
  sas?: Secret;
  /** Access key ID (`AccessKey`). */
  accessKeyId?: string;
  /** Secret access key (`AccessKey`). */
  secretAccessKey?: Secret;
}

export interface ConnectionSettings {
  /** Authentication type of the connection target. */
  authType: ConnectionAuthType;
  /** Category of the target (`ApiKey`, `AzureOpenAI`, `CognitiveSearch`, `AzureBlob`, `CustomKeys`, ...). */
  category?: ConnectionCategory;
  /** Target URL or ARM resource ID of the connected resource. */
  target?: string;
  /**
   * User metadata (e.g. `ApiType`, `ResourceId`). Alchemy ownership
   * markers are merged in because connections have no tags.
   */
  metadata?: Record<string, string>;
  /** Credentials for `authType`. Write-only. */
  credentials?: ConnectionCredentials;
  /** Share the connection with every user of the account or project. */
  isSharedToAll?: boolean;
  /** Users the connection is shared with when not shared to all. */
  sharedUserList?: string[];
  /** Expiry time of the credentials (ISO 8601). */
  expiryTime?: string;
  /** Authenticate with the workspace managed identity. */
  useWorkspaceManagedIdentity?: boolean;
  /** Private endpoint requirement: `Required`, `NotRequired`, or `NotApplicable`. */
  peRequirement?: "Required" | "NotRequired" | "NotApplicable";
}

/** Attributes shared by account and project connections. */
export interface ConnectionAttrs {
  /** Name of the connection. */
  connectionName: string;
  /** ARM resource ID of the connection. */
  connectionId: string;
  /** Authentication type. */
  authType: string;
  /** Category of the target. */
  category: string | undefined;
  /** Target URL or resource ID. */
  target: string | undefined;
  /** Whether the connection is shared to all users. */
  isSharedToAll: boolean;
  /** User metadata (Alchemy markers stripped). */
  metadata: Record<string, string>;
}

const CREDENTIALS_HASH = "alchemy::credentials";

const reveal = (value: unknown): unknown => {
  if (Redacted.isRedacted(value)) return Redacted.value(value);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        reveal(v),
      ]),
    );
  }
  return value;
};

/** Desired connection properties (credentials revealed) and metadata. */
export const desiredConnection = Effect.fn(function* (
  id: string,
  settings: ConnectionSettings,
) {
  const credentials =
    settings.credentials === undefined
      ? undefined
      : (reveal(settings.credentials) as Record<string, unknown>);
  const hash =
    credentials === undefined
      ? undefined
      : yield* Effect.sync(() =>
          createHash("sha256")
            .update(JSON.stringify(credentials))
            .digest("hex")
            .slice(0, 32),
        );
  const metadata: Record<string, string> = {
    ...settings.metadata,
    ...(yield* ownershipMarkers(id)),
    ...(hash === undefined ? {} : { [CREDENTIALS_HASH]: hash }),
  };
  const properties: cognitiveservices.ConnectionPropertiesV2Input = {
    authType: settings.authType,
    category: settings.category,
    target: settings.target,
    metadata,
    credentials,
    isSharedToAll: settings.isSharedToAll,
    sharedUserList: settings.sharedUserList,
    expiryTime: settings.expiryTime,
    useWorkspaceManagedIdentity: settings.useWorkspaceManagedIdentity,
    peRequirement: settings.peRequirement,
  };
  return properties;
});

/**
 * Whether the observed connection matches the desired one. Credentials are
 * compared through the hash stored in metadata.
 */
export const connectionMatches = (
  observed: cognitiveservices.ConnectionPropertiesV2,
  desired: cognitiveservices.ConnectionPropertiesV2Input,
) =>
  observed.authType === desired.authType &&
  (desired.category === undefined || observed.category === desired.category) &&
  (desired.target === undefined || observed.target === desired.target) &&
  (desired.isSharedToAll === undefined ||
    (observed.isSharedToAll ?? false) === desired.isSharedToAll) &&
  (desired.sharedUserList === undefined ||
    sameValue(
      [...(observed.sharedUserList ?? [])].sort(),
      [...desired.sharedUserList].sort(),
    )) &&
  (desired.expiryTime === undefined ||
    observed.expiryTime === desired.expiryTime) &&
  (desired.useWorkspaceManagedIdentity === undefined ||
    (observed.useWorkspaceManagedIdentity ?? false) ===
      desired.useWorkspaceManagedIdentity) &&
  (desired.peRequirement === undefined ||
    observed.peRequirement === desired.peRequirement) &&
  sameValue(observed.metadata ?? {}, desired.metadata ?? {});

export const connectionAttrs = (
  name: string,
  connection: {
    readonly id?: string;
    readonly properties: cognitiveservices.ConnectionPropertiesV2;
  },
): ConnectionAttrs => ({
  connectionName: name,
  connectionId: connection.id ?? "",
  authType: connection.properties.authType,
  category: connection.properties.category,
  target: connection.properties.target,
  isSharedToAll: connection.properties.isSharedToAll ?? false,
  metadata: withoutMarkers(connection.properties.metadata),
});
