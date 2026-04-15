import * as p from "@clack/prompts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as AWS from "./AWS/AuthProvider.ts";
import * as Cloudflare from "./Cloudflare/AuthProvider.ts";
import { type AlchemyProfile, getProfile, setProfile } from "./Config.ts";

export type { AuthProvider } from "./AuthProvider.ts";
export {
  getProfile,
  rootDir,
  setProfile,
  type AlchemyConfig,
  type AlchemyProfile,
} from "./Config.ts";
export {
  credentialsFilePath,
  deleteCredentials,
  displayRedacted,
  readCredentials,
  Redacted,
  writeCredentials,
} from "./Credentials.ts";
export { AWS, Cloudflare };

type ProviderKey = "aws" | "cloudflare";

const PROVIDER_LABELS: Record<ProviderKey, string> = {
  aws: "AWS",
  cloudflare: "Cloudflare",
};

const ALL_PROVIDERS: ProviderKey[] = ["aws", "cloudflare"];

function describeMethod(key: ProviderKey, profile: AlchemyProfile): string {
  const cfg = profile[key];
  if (!cfg) return "";
  if (key === "aws") {
    const aws = cfg as AWS.AwsAuthConfig;
    if (aws.method === "sso") return `sso (${aws.ssoProfile})`;
    return aws.method;
  }
  const cf = cfg as Cloudflare.CloudflareAuthConfig;
  if (cf.method === "stored") return `stored (${cf.credentialType})`;
  return cf.method;
}

const configureProvider = (
  key: ProviderKey,
  profileName: string,
  isReconfigure: boolean,
): Effect.Effect<
  AWS.AwsAuthConfig | Cloudflare.CloudflareAuthConfig | "remove" | undefined,
  never,
  AuthRequirements
> =>
  Effect.gen(function* () {
    if (key === "aws") {
      const aws = yield* AWS.AwsAuth;
      return yield* aws.configure(profileName, isReconfigure);
    }
    const cf = yield* Cloudflare.CfAuth;
    return yield* cf.configure(profileName, isReconfigure);
  });

const loginProvider = (
  key: ProviderKey,
  profileName: string,
  config: AWS.AwsAuthConfig | Cloudflare.CloudflareAuthConfig,
): Effect.Effect<void, never, AuthRequirements> =>
  Effect.gen(function* () {
    if (key === "aws") {
      const aws = yield* AWS.AwsAuth;
      return yield* aws.login(profileName, config as AWS.AwsAuthConfig);
    }
    const cf = yield* Cloudflare.CfAuth;
    return yield* cf.login(
      profileName,
      config as Cloudflare.CloudflareAuthConfig,
    );
  });

const logoutProvider = (
  key: ProviderKey,
  profileName: string,
  config: AWS.AwsAuthConfig | Cloudflare.CloudflareAuthConfig,
): Effect.Effect<void, never, AuthRequirements> =>
  Effect.gen(function* () {
    if (key === "aws") {
      const aws = yield* AWS.AwsAuth;
      return yield* aws.logout(profileName, config as AWS.AwsAuthConfig);
    }
    const cf = yield* Cloudflare.CfAuth;
    return yield* cf.logout(
      profileName,
      config as Cloudflare.CloudflareAuthConfig,
    );
  });

type AuthRequirements =
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner;

export const layer = (profileName: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const profile = yield* getProfile(profileName);
      if (!profile) return Layer.empty;

      const awsAuth = yield* AWS.AwsAuth;
      const cfAuth = yield* Cloudflare.CfAuth;

      const awsLayer = profile.aws
        ? Layer.merge(
            awsAuth.credentialsLayer(profileName, profile.aws),
            AWS.stageConfigLayer(profile.aws),
          )
        : undefined;

      const cfLayer = profile.cloudflare
        ? Layer.merge(
            cfAuth.credentialsLayer(profileName, profile.cloudflare),
            Cloudflare.stageConfigLayer(profile.cloudflare),
          )
        : undefined;

      if (awsLayer && cfLayer) return Layer.merge(awsLayer, cfLayer);
      if (awsLayer) return awsLayer;
      if (cfLayer) return cfLayer;
      return Layer.empty;
    }),
  );

export const configure = (
  profileName: string,
): Effect.Effect<boolean, never, AuthRequirements> =>
  Effect.gen(function* () {
    const existing = yield* getProfile(profileName);
    const isFirstTime = !existing;

    yield* Effect.sync(() =>
      p.intro(`Alchemy Effect — Configure profile: ${profileName}`),
    );

    if (isFirstTime) {
      return yield* configureFirstTime(profileName);
    }
    return yield* configureExisting(profileName, existing);
  });

const configureFirstTime = (
  profileName: string,
): Effect.Effect<boolean, never, AuthRequirements> =>
  Effect.gen(function* () {
    const selected = yield* Effect.promise(() =>
      p.multiselect({
        message: "Which providers would you like to enable?",
        options: ALL_PROVIDERS.map((key) => ({
          value: key,
          label: PROVIDER_LABELS[key],
        })),
        required: true,
      }),
    );
    if (p.isCancel(selected)) {
      p.cancel("Configuration cancelled.");
      return false;
    }

    const profile: AlchemyProfile = {};
    const toLogin: {
      key: ProviderKey;
      config: AWS.AwsAuthConfig | Cloudflare.CloudflareAuthConfig;
    }[] = [];

    for (const key of selected) {
      const result = yield* configureProvider(key, profileName, false);
      if (result === undefined) {
        p.cancel("Configuration cancelled.");
        return false;
      }
      profile[key] = result as any;
      toLogin.push({ key, config: result as any });
    }

    yield* Effect.orDie(setProfile(profileName, profile));
    p.log.success(`Profile "${profileName}" saved.`);

    for (const { key, config } of toLogin) {
      yield* loginProvider(key, profileName, config);
    }

    p.outro("Done.");
    return true;
  });

const configureExisting = (
  profileName: string,
  existing: AlchemyProfile,
): Effect.Effect<boolean, never, AuthRequirements> =>
  Effect.gen(function* () {
    const enabled = ALL_PROVIDERS.filter((k) => existing[k]);
    const disabled = ALL_PROVIDERS.filter((k) => !existing[k]);
    const sorted = [...enabled, ...disabled];

    const selected = yield* Effect.promise(() =>
      p.multiselect({
        message: "Which providers would you like to change?",
        options: sorted.map((key) => {
          const cfg = existing[key];
          return {
            value: key,
            label: PROVIDER_LABELS[key],
            hint: cfg
              ? `enabled — ${describeMethod(key, existing)}`
              : "not configured",
          };
        }),
        required: false,
      }),
    );
    if (p.isCancel(selected)) {
      p.cancel("Configuration cancelled.");
      return false;
    }

    if (selected.length === 0) {
      p.log.info("Nothing to change.");
      p.outro("Done.");
      return true;
    }

    const profile: AlchemyProfile = { ...existing };
    const toLogin: {
      key: ProviderKey;
      config: AWS.AwsAuthConfig | Cloudflare.CloudflareAuthConfig;
    }[] = [];
    const toLogout: {
      key: ProviderKey;
      config: AWS.AwsAuthConfig | Cloudflare.CloudflareAuthConfig;
    }[] = [];

    for (const key of selected) {
      const wasConfigured = !!existing[key];
      const result = yield* configureProvider(key, profileName, wasConfigured);

      if (result === undefined) {
        p.cancel("Configuration cancelled.");
        return false;
      }

      if (result === "remove") {
        if (existing[key]) {
          toLogout.push({ key, config: existing[key]! as any });
        }
        delete profile[key];
        continue;
      }

      // Only logout the old config when the method changes. If the user
      // reconfigured to the same method, configureProvider already wrote
      // fresh credentials — logging out would revoke them.
      const oldConfig = existing[key] as
        | { method: string; credentialType?: string }
        | undefined;
      const newConfig = result as { method: string; credentialType?: string };
      const methodChanged =
        !!oldConfig &&
        (oldConfig.method !== newConfig.method ||
          oldConfig.credentialType !== newConfig.credentialType);
      if (wasConfigured && existing[key] && methodChanged) {
        toLogout.push({ key, config: existing[key]! as any });
      }
      profile[key] = result as any;
      toLogin.push({ key, config: result as any });
    }

    yield* Effect.orDie(setProfile(profileName, profile));
    p.log.success(`Profile "${profileName}" saved.`);

    for (const { key, config } of toLogout) {
      yield* logoutProvider(key, profileName, config);
    }

    for (const { key, config } of toLogin) {
      yield* loginProvider(key, profileName, config);
    }

    p.outro("Done.");
    return true;
  });

export const login = (
  profileName: string,
): Effect.Effect<void, never, AuthRequirements> =>
  Effect.gen(function* () {
    const profile = yield* getProfile(profileName);

    if (!profile) {
      yield* configure(profileName);
      return;
    }

    p.intro(`Alchemy Effect — Login (profile: ${profileName})`);

    if (!profile.aws && !profile.cloudflare) {
      p.log.warn(
        "No providers configured. Run 'alchemy-effect login --configure' to set up.",
      );
      p.outro("Done.");
      return;
    }

    if (profile.aws) {
      const aws = yield* AWS.AwsAuth;
      yield* aws.login(profileName, profile.aws);
    }
    if (profile.cloudflare) {
      const cf = yield* Cloudflare.CfAuth;
      yield* cf.login(profileName, profile.cloudflare);
    }

    p.outro("Login complete.");
  });

export const logout = (
  profileName: string,
): Effect.Effect<void, never, AuthRequirements> =>
  Effect.gen(function* () {
    const profile = yield* getProfile(profileName);

    if (!profile) {
      p.log.warn(
        `No profile found for "${profileName}". Nothing to log out of.`,
      );
      return;
    }

    p.intro(`Alchemy Effect — Logout (profile: ${profileName})`);

    if (!profile.aws && !profile.cloudflare) {
      p.log.warn("No providers configured.");
      p.outro("Done.");
      return;
    }

    if (profile.aws) {
      const aws = yield* AWS.AwsAuth;
      yield* aws.logout(profileName, profile.aws);
    }
    if (profile.cloudflare) {
      const cf = yield* Cloudflare.CfAuth;
      yield* cf.logout(profileName, profile.cloudflare);
    }

    p.outro("Logout complete.");
  });

export const viewAuth = (
  profileName: string,
): Effect.Effect<void, never, AuthRequirements> =>
  Effect.gen(function* () {
    const profile = yield* getProfile(profileName);

    if (!profile) {
      yield* Console.log(
        `No profile found for "${profileName}". Run: alchemy-effect login`,
      );
      return;
    }

    yield* Console.log(
      `\nAlchemy Effect — View Auth (profile: ${profileName})\n`,
    );

    if (profile.aws) {
      const aws = yield* AWS.AwsAuth;
      yield* aws.prettyPrint(profileName, profile.aws);
      yield* Console.log("");
    }

    if (profile.cloudflare) {
      const cf = yield* Cloudflare.CfAuth;
      yield* cf.prettyPrint(profileName, profile.cloudflare);
      yield* Console.log("");
    }

    if (!profile.aws && !profile.cloudflare) {
      yield* Console.log(
        `No providers configured for "${profileName}". Run: alchemy-effect login`,
      );
    }
  });
