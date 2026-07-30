import type { CredentialsStore } from "@/Auth/Credentials";
import type { ProfileStore } from "@/Auth/Profile";
import * as Effect from "effect/Effect";

export const makeFakeProfileStore = (
  overrides?: Partial<ProfileStore["Service"]>,
): ProfileStore["Service"] => ({
  readManifest: Effect.succeed({ version: 1, profiles: {} }),
  getProfile: () => Effect.succeed(undefined),
  ensureProfile: () => Effect.succeed({}),
  createProfile: () => Effect.void,
  renameProfile: () => Effect.void,
  setDefaultProfile: () => Effect.void,
  current: Effect.succeed({ name: "default", source: "fallback" }),
  setProfile: () => Effect.void,
  deleteProfile: () => Effect.succeed(false),
  loadOrConfigure: <Config extends { method: string }>() =>
    Effect.succeed({ method: "env" } as Config),
  ...overrides,
});

export const makeFakeCredentialsStore = (
  stored?: unknown,
): CredentialsStore["Service"] => ({
  read: <T>() => Effect.succeed(stored as T | undefined),
  write: () => Effect.void,
  delete: () => Effect.void,
  deleteProfile: () => Effect.void,
});
