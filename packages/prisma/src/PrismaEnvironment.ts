import { resolveProviderConfig } from "alchemy/Auth/Resolve";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import {
  PRISMA_AUTH_PROVIDER_NAME,
  type PrismaAuthConfig,
  type PrismaResolvedCredentials,
} from "./AuthProvider.ts";
import { resolveBaseUrl } from "./internal/BaseUrl.ts";

export interface PrismaEnvironmentShape extends Omit<PrismaResolvedCredentials, "serviceToken"> {
  /** Omit when the provided `HttpClient` authenticates requests itself. */
  serviceToken?: Redacted.Redacted<string>;
  baseUrl: string;
}

/**
 * The Prisma Management API environment: the service token and base URL.
 *
 * The service holds an Effect, which Alchemy runs on every Management API
 * request. Provide one that returns the current token to keep a refreshing
 * token (a `prisma login` session) up to date for the whole deploy.
 *
 * @example
 * ```typescript
 * Layer.succeed(
 *   Prisma.PrismaEnvironment,
 *   Effect.map(getAccessToken, (serviceToken) => ({
 *     type: "serviceToken" as const,
 *     serviceToken,
 *     source: { type: "stored" as const },
 *     baseUrl: "https://api.prisma.io",
 *   })),
 * );
 * ```
 */
export class PrismaEnvironment extends Context.Service<
  PrismaEnvironment,
  Effect.Effect<PrismaEnvironmentShape>
>()("Prisma::PrismaEnvironment") {
  static current = PrismaEnvironment.use((env) => env);
  readonly kind = "Environment" as const;
}

export const fromProfile = () =>
  Layer.effect(
    PrismaEnvironment,
    Effect.gen(function* () {
      const baseUrl = yield* resolveBaseUrl;
      const { resolve } = yield* resolveProviderConfig<PrismaAuthConfig, PrismaResolvedCredentials>(
        PRISMA_AUTH_PROVIDER_NAME,
      );
      const credentials = yield* resolve;
      return Effect.succeed({ ...credentials, baseUrl });
    }),
  );
