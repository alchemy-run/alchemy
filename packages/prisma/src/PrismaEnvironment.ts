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

export class PrismaEnvironment extends Context.Service<PrismaEnvironment, PrismaEnvironmentShape>()(
  "Prisma::PrismaEnvironment",
) {}

export const fromProfile = () =>
  Layer.effect(
    PrismaEnvironment,
    Effect.gen(function* () {
      const baseUrl = yield* resolveBaseUrl;
      const { resolve } = yield* resolveProviderConfig<PrismaAuthConfig, PrismaResolvedCredentials>(
        PRISMA_AUTH_PROVIDER_NAME,
      );
      const credentials = yield* resolve;
      return { ...credentials, baseUrl };
    }),
  );
