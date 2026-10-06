import * as Containers from "@distilled.cloud/cloudflare/containers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { RegistryAuth, ImageRegistryError } from "../../Docker/ImageRegistry.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";

type CredentialsError = Containers.CreateContainerRegistryCredentialsError;

/**
 * Classify a failure to mint Cloudflare registry credentials. Only rejected
 * or unavailable credentials are authentication failures; throttling,
 * transport, and server errors stay request failures. Every mapped error keeps
 * the original failure as its `cause`.
 */
const credentialsFailure = (error: CredentialsError): ImageRegistryError => {
  const fail = (reason: "AuthenticationFailed" | "RequestFailed", status?: number) =>
    new ImageRegistryError({
      reason,
      status,
      message:
        reason === "AuthenticationFailed"
          ? `Cloudflare rejected the container registry credentials request (${error._tag})`
          : `Unable to acquire Cloudflare container registry credentials (${error._tag})`,
      cause: error,
    });
  switch (error._tag) {
    case "Unauthorized":
      return fail("AuthenticationFailed", 401);
    case "CloudflareOAuthRefreshError":
    case "ConfigError":
      return fail("AuthenticationFailed");
    case "CloudflareError":
    case "CloudflareHttpError":
      return fail(
        error.status === 401 || error.status === 403 ? "AuthenticationFailed" : "RequestFailed",
        error.status,
      );
    case "CloudflareRateLimited":
      return fail("RequestFailed", error.status);
    case "TooManyRequests":
      return fail("RequestFailed", 429);
    case "InternalServerError":
      return fail("RequestFailed", 500);
    case "BadGateway":
      return fail("RequestFailed", 502);
    case "ServiceUnavailable":
      return fail("RequestFailed", 503);
    case "GatewayTimeout":
      return fail("RequestFailed", 504);
    default:
      return fail("RequestFailed");
  }
};

export const ContainerRegistryAuth = Layer.effect(
  RegistryAuth,
  Effect.gen(function* () {
    const services = yield* Effect.context<
      | CloudflareEnvironment
      | Effect.Services<ReturnType<typeof Containers.createContainerRegistryCredentials>>
    >();
    const resolve = Effect.fn(function* (
      server: string,
      permissions: ReadonlyArray<"pull" | "push">,
    ) {
      if (server !== "registry.cloudflare.com") return undefined;
      const { accountId } = yield* yield* CloudflareEnvironment;
      const credentials = yield* Containers.createContainerRegistryCredentials({
        accountId,
        registryId: server,
        permissions: [...permissions],
        expirationMinutes: 60,
      }).pipe(Effect.mapError(credentialsFailure));
      const username = credentials.username ?? credentials.user;
      if (!username)
        return yield* new ImageRegistryError({
          reason: "AuthenticationFailed",
          message: "Cloudflare registry credentials are missing a username",
        });
      return {
        server,
        username,
        password: Redacted.isRedacted(credentials.password)
          ? credentials.password
          : Redacted.make(credentials.password),
      };
    });
    return RegistryAuth.of({
      resolve: (server, permissions) =>
        resolve(server, permissions).pipe(Effect.provide(Layer.succeedContext(services))),
    });
  }),
);
