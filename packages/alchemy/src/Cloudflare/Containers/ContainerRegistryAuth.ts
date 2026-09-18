import * as Containers from "@distilled.cloud/cloudflare/containers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
  RegistryAuth,
  ImageRegistryError,
} from "../../Docker/ImageRegistry.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";

export const ContainerRegistryAuth = Layer.effect(
  RegistryAuth,
  Effect.gen(function* () {
    const services = yield* Effect.context<
      | CloudflareEnvironment
      | Effect.Services<
          ReturnType<typeof Containers.createContainerRegistryCredentials>
        >
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
      });
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
        resolve(server, permissions).pipe(
          Effect.provide(Layer.succeedContext(services)),
          Effect.mapError(
            () =>
              new ImageRegistryError({
                reason: "AuthenticationFailed",
                message: "Unable to acquire Cloudflare registry credentials",
              }),
          ),
        ),
    });
  }),
);
