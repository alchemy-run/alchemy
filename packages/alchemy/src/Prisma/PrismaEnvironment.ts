import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { getAuthProvider } from "../Auth/AuthProvider.ts";
import { ALCHEMY_PROFILE, AlchemyProfile } from "../Auth/Profile.ts";
import {
  PRISMA_AUTH_PROVIDER_NAME,
  type PrismaAuthConfig,
  type PrismaResolvedCredentials,
} from "./AuthProvider.ts";

export interface PrismaEnvironmentShape extends PrismaResolvedCredentials {
  baseUrl: string;
}

export class PrismaEnvironment extends Context.Service<
  PrismaEnvironment,
  PrismaEnvironmentShape
>()("Prisma::PrismaEnvironment") {}

const DEFAULT_BASE_URL = "https://api.prisma.io";
const PRISMA_API_URL_ENV = "PRISMA_API_URL";
const PRISMA_MANAGEMENT_API_URL_ENV = "PRISMA_MANAGEMENT_API_URL";

export const fromProfile = () =>
  Layer.effect(
    PrismaEnvironment,
    Effect.gen(function* () {
      const profile = yield* AlchemyProfile;
      const auth = yield* getAuthProvider<
        PrismaAuthConfig,
        PrismaResolvedCredentials
      >(PRISMA_AUTH_PROVIDER_NAME);
      const profileName = yield* ALCHEMY_PROFILE;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));
      const baseUrl = yield* Config.string(PRISMA_API_URL_ENV).pipe(
        Config.orElse(() => Config.string(PRISMA_MANAGEMENT_API_URL_ENV)),
        Config.withDefault(DEFAULT_BASE_URL),
      );
      const config = yield* profile.loadOrConfigure(auth, profileName, { ci });
      const credentials = yield* auth.read(
        profileName,
        config as PrismaAuthConfig,
      );
      return { ...credentials, baseUrl };
    }),
  );
