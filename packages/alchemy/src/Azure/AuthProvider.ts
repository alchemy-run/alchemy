import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { getEnvRedactedRequired, getEnvRequired } from "../Auth/Env.ts";
import {
  makeStoredAuthProvider,
  storedSecret,
  storedValueText,
  type StoredAuthConfig,
} from "../Auth/StoredAuthProvider.ts";

export const AZURE_AUTH_PROVIDER_NAME = "Azure";
export const AZURE_TENANT_ID_ENV = "AZURE_TENANT_ID";
export const AZURE_CLIENT_ID_ENV = "AZURE_CLIENT_ID";
export const AZURE_CLIENT_SECRET_ENV = "AZURE_CLIENT_SECRET";
export const AZURE_SUBSCRIPTION_ID_ENV = "AZURE_SUBSCRIPTION_ID";

/** Location used when neither the profile nor an `Azure.Location` layer names one. */
export const DEFAULT_AZURE_LOCATION = "eastus";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validateGuid = (value: string) =>
  GUID.test(value.trim()) ? undefined : "Must be a GUID";

export type AzureAuthConfig = StoredAuthConfig;

/**
 * A Microsoft Entra service principal plus the subscription it deploys
 * into. Access tokens are minted from it on demand (see `Credentials.ts`).
 */
export type AzureResolvedCredentials = {
  type: "servicePrincipal";
  tenantId: string;
  clientId: string;
  clientSecret: Redacted.Redacted<string>;
  subscriptionId: string;
  /** Default location for resources created without an explicit one. */
  location: string;
  source: { type: AzureAuthConfig["method"] | "env"; details?: string };
};

const azureAuth = makeStoredAuthProvider<AzureResolvedCredentials>({
  provider: AZURE_AUTH_PROVIDER_NAME,
  fields: [
    {
      name: "tenantId",
      label: "Microsoft Entra tenant (directory) ID",
      validate: validateGuid,
    },
    {
      name: "clientId",
      label: "Service principal application (client) ID",
      validate: validateGuid,
    },
    {
      name: "clientSecret",
      label: "Service principal client secret",
      secret: true,
    },
    {
      name: "subscriptionId",
      label: "Azure subscription ID",
      validate: validateGuid,
    },
    {
      name: "location",
      label: "Default Azure location",
      optional: true,
      placeholder: DEFAULT_AZURE_LOCATION,
    },
  ],
  toResolved: (values) => ({
    type: "servicePrincipal",
    tenantId: storedValueText(values.tenantId) ?? "",
    clientId: storedValueText(values.clientId) ?? "",
    clientSecret: storedSecret(values.clientSecret) ?? Redacted.make(""),
    subscriptionId: storedValueText(values.subscriptionId) ?? "",
    location: storedValueText(values.location) ?? DEFAULT_AZURE_LOCATION,
    source: { type: "stored" },
  }),
  readEnvironment: Effect.all({
    tenantId: getEnvRequired(AZURE_TENANT_ID_ENV),
    clientId: getEnvRequired(AZURE_CLIENT_ID_ENV),
    clientSecret: getEnvRedactedRequired(AZURE_CLIENT_SECRET_ENV),
    subscriptionId: getEnvRequired(AZURE_SUBSCRIPTION_ID_ENV),
  }).pipe(
    Effect.map(({ tenantId, clientId, clientSecret, subscriptionId }) => ({
      type: "servicePrincipal" as const,
      tenantId,
      clientId,
      clientSecret,
      subscriptionId,
      location: DEFAULT_AZURE_LOCATION,
      source: {
        type: "env" as const,
        details: `${AZURE_CLIENT_ID_ENV}, ${AZURE_TENANT_ID_ENV}`,
      },
    })),
  ),
  environment: [
    { name: AZURE_TENANT_ID_ENV, required: true },
    { name: AZURE_CLIENT_ID_ENV, required: true },
    { name: AZURE_CLIENT_SECRET_ENV, required: true, secret: true },
    { name: AZURE_SUBSCRIPTION_ID_ENV, required: true },
  ],
});

/**
 * Layer that registers the Azure {@link AuthProvider} into the
 * {@link AuthProviders} registry.
 *
 * Auth is a Microsoft Entra service principal (tenant ID, client ID, client
 * secret) plus a subscription ID. In CI the standard Azure SDK variables
 * `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, and
 * `AZURE_SUBSCRIPTION_ID` are read instead of the profile.
 */
export const AzureAuth = azureAuth.layer;
