import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Binding from "../Binding.ts";
import type { Input } from "../Input.ts";
import type { ResourceLike } from "../Resource.ts";

/**
 * One Azure RBAC grant a binding asks its host to hold: the host's
 * system-assigned managed identity gets `roleDefinitionId` on `scope`.
 */
export interface AzureRoleAssignmentBinding {
  /** Built-in or custom role GUID, or a full role-definition ARM ID. */
  roleDefinitionId: string;
  /** ARM ID the role is granted on — the bound resource, never wider. */
  scope: string;
}

/**
 * Binding contract accepted by Azure hosts (Container Apps, Function Apps):
 * environment variables plus least-privilege role assignments for the host's
 * system-assigned managed identity.
 */
export interface AzureBindingContract {
  env?: Record<string, string>;
  roleAssignments?: AzureRoleAssignmentBinding[];
}

/** Built-in data-plane roles used by Azure capability bindings. */
export const AzureDataRole = {
  StorageBlobDataReader: "2a2b9908-6ea1-4ae2-8e65-a410df84e7d1",
  StorageBlobDataContributor: "ba92f5b4-2d11-453e-a403-e96b0029c9fe",
  StorageQueueDataMessageSender: "c6a89b2d-59bc-44d0-9896-0f6e12d7b80a",
  StorageQueueDataMessageProcessor: "8a0f0c08-91a1-4084-bc3d-661d67231fb1",
  ServiceBusDataSender: "69a216fc-b8fb-44d8-bc22-1f3c2cd27a39",
  ServiceBusDataReceiver: "4f6d3b9b-027b-4f4c-9142-0e5a2a2247e0",
  KeyVaultSecretsUser: "4633458b-17de-408a-b874-0445c86b69e6",
  EventHubsDataSender: "2b629674-e913-4c01-ae53-ef4638d8f975",
} as const;

/**
 * Shape of an Azure host that accepts {@link AzureBindingContract} — every
 * Alchemy resource exposes this `bind` overload pair.
 */
export interface AzureHostShape {
  readonly LogicalId: string;
  bind(
    sid: Input<string>,
    binding: Input<AzureBindingContract>,
  ): Effect.Effect<void>;
}

/**
 * Optional explicit host. An Effect-native Azure runtime may provide this tag
 * during its init phase; otherwise bindings fall back to the ambient
 * `Binding.Host` when its type is a registered Azure host type.
 */
export class AzureHost extends Context.Service<AzureHost, AzureHostShape>()(
  "Azure.Host",
) {}

const hostTypes = new Set<string>([
  "Azure.ContainerApps.ContainerApp",
  "Azure.Web.FunctionApp",
]);

/** Register another resource type that applies {@link AzureBindingContract}. */
export const registerAzureHostType = (type: string) => {
  hostTypes.add(type);
};

/** True for a resource whose provider applies {@link AzureBindingContract}. */
export const isAzureHost = (value: unknown): value is AzureHostShape =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  hostTypes.has((value as { Type?: unknown }).Type as string) &&
  typeof (value as { bind?: unknown }).bind === "function";

/**
 * Deploy-time half of an Azure binding: register env vars and role
 * assignments on the ambient host. A no-op at runtime and when no Azure
 * host is in context (plan-time `execute`, scripts, tests).
 */
export const bindAzureHost = Effect.fn(function* (options: {
  /** Fully-qualified binding tag, e.g. `Azure.Storage.BlobContainerRead`. */
  tag: string;
  resource: ResourceLike;
  env?: Record<string, Input<string>>;
  roleAssignments?: Array<{
    roleDefinitionId: string;
    scope: Input<string>;
  }>;
}) {
  if (globalThis.__ALCHEMY_RUNTIME__) return;
  const explicit = yield* Effect.serviceOption(AzureHost);
  const host = explicit._tag === "Some" ? explicit.value : yield* Binding.Host;
  if (!isAzureHost(host)) return;
  yield* host.bind(
    `Allow(${host.LogicalId}, ${options.tag}(${options.resource.LogicalId}))`,
    {
      env: options.env,
      roleAssignments: options.roleAssignments,
    } as Input<AzureBindingContract>,
  );
});

/** Env-var-safe suffix derived from a logical ID. */
export const envSuffix = (logicalId: string) =>
  logicalId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();

export class AzureManagedIdentityError extends Data.TaggedError(
  "AzureManagedIdentityError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** A non-2xx response (or transport failure) from an Azure data plane. */
export class AzureDataPlaneError extends Data.TaggedError(
  "AzureDataPlaneError",
)<{
  readonly message: string;
  /** HTTP status; `0` when the request never got a response. */
  readonly status: number;
  /** Service error code (`x-ms-error-code` or the JSON `error.code`). */
  readonly code: string | undefined;
  readonly cause?: unknown;
}> {}

/** Refresh this long before a token expires. */
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** `https://storage.azure.com/.default` → `https://storage.azure.com/`. */
const toResource = (scope: string) =>
  scope.endsWith("/.default")
    ? `${scope.slice(0, -"/.default".length)}/`
    : scope;

const readEnv = (name: string) =>
  Effect.sync(() => {
    const value = process.env[name];
    return value === undefined || value === "" ? undefined : value;
  });

/**
 * Access token for `scope` (e.g. `https://storage.azure.com/.default`) from
 * the host's managed identity: the App Service / Container Apps identity
 * endpoint (`IDENTITY_ENDPOINT` + `IDENTITY_HEADER`), else IMDS. Tokens are
 * cached per resource until five minutes before expiry.
 */
export const managedIdentityToken = Effect.fn("Azure.managedIdentityToken")(
  function* (scope: string) {
    const http = yield* HttpClient.HttpClient;
    const resource = toResource(scope);
    const now = yield* Clock.currentTimeMillis;
    const cached = tokenCache.get(resource);
    if (cached !== undefined && cached.expiresAt - REFRESH_WINDOW_MS > now) {
      return cached.token;
    }
    const endpoint = yield* readEnv("IDENTITY_ENDPOINT");
    const header = yield* readEnv("IDENTITY_HEADER");
    const clientId = yield* readEnv("AZURE_CLIENT_ID");
    const request =
      endpoint !== undefined && header !== undefined
        ? HttpClientRequest.get(endpoint).pipe(
            HttpClientRequest.setUrlParams({
              resource,
              "api-version": "2019-08-01",
              ...(clientId ? { client_id: clientId } : {}),
            }),
            HttpClientRequest.setHeader("X-IDENTITY-HEADER", header),
          )
        : HttpClientRequest.get(
            "http://169.254.169.254/metadata/identity/oauth2/token",
          ).pipe(
            HttpClientRequest.setUrlParams({
              resource,
              "api-version": "2018-02-01",
              ...(clientId ? { client_id: clientId } : {}),
            }),
            HttpClientRequest.setHeader("Metadata", "true"),
          );
    const response = yield* http.execute(request).pipe(
      Effect.mapError(
        (cause) =>
          new AzureManagedIdentityError({
            message: `Managed identity endpoint is unreachable: ${cause.message}`,
            cause,
          }),
      ),
    );
    const text = yield* response.text.pipe(
      Effect.mapError(
        (cause) =>
          new AzureManagedIdentityError({
            message: `Reading the managed identity token failed: ${cause.message}`,
            cause,
          }),
      ),
    );
    if (response.status !== 200) {
      return yield* new AzureManagedIdentityError({
        message: `Managed identity endpoint returned HTTP ${response.status}: ${text}`,
      });
    }
    const body = yield* Effect.try({
      try: () =>
        JSON.parse(text) as { access_token?: unknown; expires_on?: unknown },
      catch: (cause) =>
        new AzureManagedIdentityError({
          message: "Managed identity endpoint returned invalid JSON",
          cause,
        }),
    });
    if (typeof body.access_token !== "string") {
      return yield* new AzureManagedIdentityError({
        message: "Managed identity response has no access_token",
      });
    }
    const expiresOn = Number(body.expires_on);
    tokenCache.set(resource, {
      token: body.access_token,
      expiresAt: Number.isFinite(expiresOn)
        ? expiresOn * 1000
        : now + 30 * 60_000,
    });
    return body.access_token;
  },
);

const errorCodeOf = (
  response: HttpClientResponse.HttpClientResponse,
  text: string,
) => {
  const header = response.headers["x-ms-error-code"];
  if (header !== undefined) return header;
  const xml = text.match(/<Code>([^<]+)<\/Code>/)?.[1];
  if (xml !== undefined) return xml;
  try {
    const json = JSON.parse(text) as { error?: { code?: unknown } };
    return typeof json.error?.code === "string" ? json.error.code : undefined;
  } catch {
    return undefined;
  }
};

/** A successful data-plane response with its body read as text. */
export interface AzureDataPlaneResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Body decoded as UTF-8. */
  readonly text: string;
  /** Raw body bytes. */
  readonly bytes: Uint8Array;
}

/**
 * Execute a data-plane request authenticated with the managed identity
 * token for `scope`. Non-2xx statuses (other than those in `allow`) fail
 * with {@link AzureDataPlaneError}.
 */
export const azureDataPlaneRequest = (
  http: HttpClient.HttpClient,
  scope: string,
  request: HttpClientRequest.HttpClientRequest,
  options?: { allow?: readonly number[] },
): Effect.Effect<
  AzureDataPlaneResponse,
  AzureDataPlaneError | AzureManagedIdentityError
> =>
  Effect.gen(function* () {
    const token = yield* managedIdentityToken(scope).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );
    const response = yield* http
      .execute(HttpClientRequest.bearerToken(request, token))
      .pipe(
        Effect.mapError(
          (cause) =>
            new AzureDataPlaneError({
              message: `${request.method} ${request.url} failed: ${cause.message}`,
              status: 0,
              code: undefined,
              cause,
            }),
        ),
      );
    const bytes =
      request.method === "HEAD"
        ? new Uint8Array(0)
        : new Uint8Array(
            yield* response.arrayBuffer.pipe(
              Effect.mapError(
                (cause) =>
                  new AzureDataPlaneError({
                    message: `Reading ${request.url} failed: ${cause.message}`,
                    status: response.status,
                    code: undefined,
                    cause,
                  }),
              ),
            ),
          );
    const text = yield* Effect.sync(() => new TextDecoder().decode(bytes));
    const ok =
      (response.status >= 200 && response.status < 300) ||
      (options?.allow ?? []).includes(response.status);
    if (!ok) {
      const code = errorCodeOf(response, text);
      return yield* new AzureDataPlaneError({
        message: `${request.method} ${request.url} returned HTTP ${response.status}${code ? ` (${code})` : ""}: ${text.slice(0, 500)}`,
        status: response.status,
        code,
      });
    }
    return { status: response.status, headers: response.headers, text, bytes };
  });

/** Decode the five predefined XML entities. */
export const xmlDecode = (value: string) =>
  value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** Escape text for an XML element body. */
export const xmlEncode = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Text of the first `<tag>` element inside `xml`, decoded. */
export const xmlField = (xml: string, tag: string) => {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match?.[1] === undefined ? undefined : xmlDecode(match[1]);
};

/** Bodies of every `<tag>…</tag>` element inside `xml`. */
export const xmlElements = (xml: string, tag: string) =>
  [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map(
    (m) => m[1] ?? "",
  );
