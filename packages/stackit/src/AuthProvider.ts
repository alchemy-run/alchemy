import { DEFAULT_REGION } from "@distilled.cloud/stackit/Credentials";
import { AuthError } from "alchemy/Auth/AuthProvider";
import { getEnv, getEnvRedacted, getEnvRequired } from "alchemy/Auth/Env";
import {
  makeStoredAuthProvider,
  storedSecret,
  storedValueText,
  type StoredAuthConfig,
  type StoredValues,
} from "alchemy/Auth/StoredAuthProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

export const STACKIT_AUTH_PROVIDER_NAME = "Stackit";

/** STACKIT's primary public region (Germany). */
export const DEFAULT_STACKIT_REGION = DEFAULT_REGION;

/** Service-account key JSON, pasted inline (single line). */
export const STACKIT_SERVICE_ACCOUNT_KEY_ENV = "STACKIT_SERVICE_ACCOUNT_KEY";
/** Path to a service-account key JSON file. */
export const STACKIT_SERVICE_ACCOUNT_KEY_PATH_ENV = "STACKIT_SERVICE_ACCOUNT_KEY_PATH";
/** PEM private key, for keys created from your own key pair. */
export const STACKIT_PRIVATE_KEY_ENV = "STACKIT_PRIVATE_KEY";
/** Path to a PEM private key file, for keys created from your own key pair. */
export const STACKIT_PRIVATE_KEY_PATH_ENV = "STACKIT_PRIVATE_KEY_PATH";
export const STACKIT_PROJECT_ID_ENV = "STACKIT_PROJECT_ID";
export const STACKIT_ORGANIZATION_ID_ENV = "STACKIT_ORGANIZATION_ID";
export const STACKIT_REGION_ENV = "STACKIT_REGION";

export type StackitAuthConfig = StoredAuthConfig;

/**
 * Resolved STACKIT credentials: where the service-account key lives, plus
 * the project, organization and region the stack deploys into.
 *
 * Exactly one of `serviceAccountKey` / `serviceAccountKeyPath` is set. The
 * key file is read and exchanged for an access token by
 * `Credentials.fromAuthProvider()`, not here, so resolving a profile never
 * touches the file system or the network.
 */
export interface StackitResolvedCredentials {
  readonly type: "serviceAccountKey";
  /** Service-account key JSON (the file STACKIT downloads), inline. */
  readonly serviceAccountKey?: Redacted.Redacted<string>;
  /** Path to the service-account key JSON file. */
  readonly serviceAccountKeyPath?: string;
  /**
   * PEM private key, needed only when the key was created from your own key
   * pair (the downloaded JSON then has no `credentials.privateKey`).
   */
  readonly privateKey?: Redacted.Redacted<string>;
  /** Path to the PEM private key file (see {@link privateKey}). */
  readonly privateKeyPath?: string;
  /** Default project for project-scoped resources. */
  readonly projectId: string;
  /** Organization (container id) for organization-scoped resources. */
  readonly organizationId?: string;
  /** Default region for regional resources. */
  readonly region: string;
  readonly source: { type: StackitAuthConfig["method"] | "env"; details?: string };
}

/** Shallow structural check of a service-account key JSON document. */
const validateKeyJson = (text: string): Effect.Effect<void, AuthError> =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) =>
      AuthError.make({
        message:
          "Stackit: 'serviceAccountKey' is not valid JSON. Paste the key file contents on one line, or use 'serviceAccountKeyPath'.",
        cause,
      }),
  }).pipe(
    Effect.flatMap((parsed) =>
      typeof parsed === "object" &&
      parsed !== null &&
      "credentials" in parsed &&
      typeof parsed.credentials === "object" &&
      parsed.credentials !== null
        ? Effect.void
        : Effect.fail(
            AuthError.make({
              message:
                "Stackit: 'serviceAccountKey' is missing the 'credentials' object of a STACKIT service-account key.",
            }),
          ),
    ),
  );

const requireKeySource = Effect.fn(function* (values: StoredValues) {
  const inline = storedValueText(values.serviceAccountKey);
  const path = storedValueText(values.serviceAccountKeyPath);
  if (inline === undefined && path === undefined) {
    return yield* AuthError.make({
      message:
        "Stackit: set either 'serviceAccountKey' (the key JSON) or 'serviceAccountKeyPath' (a path to the key file).",
    });
  }
  if (inline !== undefined && path !== undefined) {
    return yield* AuthError.make({
      message: "Stackit: set only one of 'serviceAccountKey' and 'serviceAccountKeyPath'.",
    });
  }
  if (inline !== undefined) yield* validateKeyJson(inline);
  return values;
});

const stackitAuth = makeStoredAuthProvider<StackitResolvedCredentials>({
  provider: STACKIT_AUTH_PROVIDER_NAME,
  fields: [
    {
      name: "serviceAccountKeyPath",
      label: "Path to the STACKIT service-account key JSON file",
      description:
        "The file the STACKIT portal downloads when you create a service-account key. Leave empty to paste the key JSON instead.",
      optional: true,
    },
    {
      name: "serviceAccountKey",
      label: "STACKIT service-account key JSON (single line)",
      description: "Only when no key file path was given.",
      secret: true,
      optional: true,
    },
    {
      name: "privateKeyPath",
      label: "Path to the PEM private key",
      description:
        "Only for keys created from your own key pair; generated keys carry their private key in the JSON.",
      optional: true,
    },
    { name: "projectId", label: "STACKIT project id" },
    {
      name: "organizationId",
      label: "STACKIT organization id",
      description: "Needed only for organization-scoped resources (projects, folders).",
      optional: true,
    },
    {
      name: "region",
      label: "STACKIT region",
      optional: true,
      placeholder: DEFAULT_STACKIT_REGION,
    },
  ],
  complete: requireKeySource,
  toResolved: (values, source) => ({
    type: "serviceAccountKey",
    serviceAccountKey: storedSecret(values.serviceAccountKey),
    serviceAccountKeyPath: storedValueText(values.serviceAccountKeyPath),
    privateKeyPath: storedValueText(values.privateKeyPath),
    projectId: storedValueText(values.projectId) ?? "",
    organizationId: storedValueText(values.organizationId),
    region: storedValueText(values.region) ?? DEFAULT_STACKIT_REGION,
    source: { type: source },
  }),
  readEnvironment: Effect.gen(function* () {
    const serviceAccountKey = yield* getEnvRedacted(STACKIT_SERVICE_ACCOUNT_KEY_ENV);
    const serviceAccountKeyPath = yield* getEnv(STACKIT_SERVICE_ACCOUNT_KEY_PATH_ENV);
    if (serviceAccountKey === undefined && serviceAccountKeyPath === undefined) {
      return yield* AuthError.make({
        message: `STACKIT CI credentials not found. Set ${STACKIT_SERVICE_ACCOUNT_KEY_ENV} or ${STACKIT_SERVICE_ACCOUNT_KEY_PATH_ENV}.`,
      });
    }
    const projectId = yield* getEnvRequired(STACKIT_PROJECT_ID_ENV);
    const privateKey = yield* getEnvRedacted(STACKIT_PRIVATE_KEY_ENV);
    const privateKeyPath = yield* getEnv(STACKIT_PRIVATE_KEY_PATH_ENV);
    const organizationId = yield* getEnv(STACKIT_ORGANIZATION_ID_ENV);
    const region = (yield* getEnv(STACKIT_REGION_ENV)) ?? DEFAULT_STACKIT_REGION;
    return {
      type: "serviceAccountKey" as const,
      // An inline key wins over a path, like the official STACKIT SDKs.
      serviceAccountKey,
      serviceAccountKeyPath: serviceAccountKey === undefined ? serviceAccountKeyPath : undefined,
      privateKey,
      privateKeyPath: privateKey === undefined ? privateKeyPath : undefined,
      projectId,
      organizationId,
      region,
      source: {
        type: "env" as const,
        details:
          serviceAccountKey !== undefined
            ? STACKIT_SERVICE_ACCOUNT_KEY_ENV
            : STACKIT_SERVICE_ACCOUNT_KEY_PATH_ENV,
      },
    };
  }),
  environment: [
    {
      name: STACKIT_SERVICE_ACCOUNT_KEY_ENV,
      required: true,
      secret: true,
      alternatives: [STACKIT_SERVICE_ACCOUNT_KEY_PATH_ENV],
      description: "Service-account key JSON, or (via the _PATH variant) a path to the key file.",
    },
    {
      name: STACKIT_PROJECT_ID_ENV,
      required: true,
      description: "Default project for project-scoped resources.",
    },
    {
      name: STACKIT_PRIVATE_KEY_ENV,
      required: false,
      secret: true,
      alternatives: [STACKIT_PRIVATE_KEY_PATH_ENV],
      description: "PEM private key (or a path to it) for keys created from your own key pair.",
    },
    {
      name: STACKIT_ORGANIZATION_ID_ENV,
      required: false,
      description: "Organization id for organization-scoped resources.",
    },
    {
      name: STACKIT_REGION_ENV,
      required: false,
      description: `Default region (${DEFAULT_STACKIT_REGION}).`,
    },
  ],
});

/**
 * Layer that registers the STACKIT {@link AuthProvider} into the
 * {@link AuthProviders} registry, so `alchemy profile edit --add Stackit`
 * can configure it.
 *
 * Auth is a STACKIT service-account key (the JSON file the portal
 * downloads), exchanged for short-lived access tokens on first use. CI reads
 * `STACKIT_SERVICE_ACCOUNT_KEY` or `STACKIT_SERVICE_ACCOUNT_KEY_PATH`, plus
 * `STACKIT_PROJECT_ID` and optionally `STACKIT_ORGANIZATION_ID` and
 * `STACKIT_REGION`.
 */
export const StackitAuth = stackitAuth.layer;

/** Schema of the STACKIT profile's stored values. */
export const StackitStoredCredentials = stackitAuth.storedSchema;
export type StackitStoredCredentials = typeof StackitStoredCredentials.Type;
