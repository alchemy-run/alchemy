import * as boat from "@distilled.cloud/boat-dev/boat";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { BoatUnexpectedResponse, InvalidEnvironmentValue } from "./Errors.ts";
import { declarable } from "./internal/Declared.ts";
import { inOrg, sameOrg, stackOrg } from "./internal/Org.ts";
import { boatName, isGeneratedName } from "./internal/Ownership.ts";
import type { Providers } from "./Providers.ts";

/** A file written into every sandbox on the environment. */
export interface EnvironmentSecretFile {
  /** Where it goes, under the home directory: `.npmrc`, `~/.npmrc` or `/home/user/.npmrc`. */
  path: string;
  contents: string | Redacted.Redacted<string>;
}

/** A credential profile, by id. Accepts a `Boat.CredentialProfile`. */
export interface EnvironmentCredentialProfileRef {
  credentialProfileId: string;
}

/** An AI credentials proxy switch. Accepts a `Boat.AiProxy`. */
export interface EnvironmentAiProxyRef {
  enabled: boolean;
}

export interface EnvironmentProps {
  /**
   * Environment name: letters, digits, `.`, `-` and `_`, up to 64. If
   * omitted, a unique name is generated from the stack, stage and logical
   * ID. Renamed in place.
   */
  name?: string;
  /**
   * Environment variables every sandbox on it gets. Updated in place;
   * running sandboxes keep the version they started with. A value can't
   * hold a newline, or both `'` and `"`.
   */
  env?: Record<string, string | Redacted.Redacted<string>>;
  /** Files written into every sandbox on it. Updated in place. */
  secretFiles?: EnvironmentSecretFile[];
  /**
   * Pass nothing to sandboxes: no repositories, secrets or credentials,
   * whatever the flags below say. For sandboxes you give to third parties.
   * @default false
   */
  safeForThirdParties?: boolean;
  /**
   * Attach `env` and `secretFiles`.
   * @default true
   */
  passSecrets?: boolean;
  /**
   * Attach your GitHub token, the repositories selected on the dashboard,
   * and their setup scripts. A sandbox with it can push as you.
   * @default false
   */
  passGithub?: boolean;
  /**
   * Attach a Boat API key, so a sandbox can snapshot, stop and resume
   * itself.
   * @default false
   */
  passSandboxCredentials?: boolean;
  /**
   * Attach the keys and sign-ins of `credentialProfile`, or of the sandbox
   * owner's default profile when there is none.
   * @default true with a `credentialProfile`, else false
   */
  passAgentsCredentials?: boolean;
  /**
   * The `Boat.CredentialProfile` whose keys the sandboxes get (or
   * `{ credentialProfileId }` of one). Omit for the sandbox owner's default
   * profile.
   */
  credentialProfile?: EnvironmentCredentialProfileRef;
  /**
   * With `safeForThirdParties`, still give sandboxes the credential
   * profile, as placeholders the AI credentials proxy swaps for the real
   * keys. Real keys never enter them. Boat rejects it while the proxy is
   * off for the profile's owner, so pass the `Boat.AiProxy` that turns it
   * on: the environment then waits for it, and proxies only while it is on.
   * @default false
   */
  proxyAiCredentials?: boolean | EnvironmentAiProxyRef;
  /**
   * Make it the account's default: sandboxes created without an
   * `environment` use it.
   * @default false
   */
  isDefault?: boolean;
}

export interface EnvironmentAttributes {
  /** Boat's environment id. */
  environmentId: string;
  name: string;
  /** Each change mints a version; new sandboxes start on the latest. */
  latestVersionNumber: number;
  isDefault: boolean;
  /**
   * The organization whose shared environment this is, as the stack's
   * `org` named it; `undefined` for a personal environment.
   */
  org: string | undefined;
}

export interface Environment extends Resource<
  "Boat.Environment",
  EnvironmentProps,
  EnvironmentAttributes,
  never,
  Providers,
  { name: string }
> {}

/**
 * A Boat environment: the environment variables, secret files and
 * credential settings a sandbox starts with.
 *
 * Every change mints a new version. New sandboxes start on the latest
 * version; running ones keep the version they started with until they are
 * upgraded on the dashboard.
 *
 * An environment is personal, or shared by an organization. With an `org`
 * on the stack (`Boat.providers({ org })`, or the profile's), it is that
 * organization's: every member can use it, and owners and admins change
 * it. Without one it is yours alone, even when your active wallet is an
 * organization's. Changing the stack's `org` replaces it.
 *
 * An environment passes a sandbox its own `env` and `secretFiles`, and
 * nothing of your account. Your GitHub token, a Boat API key and your AI
 * credentials are each one flag, off until you turn it on.
 *
 * ### Creating an environment
 * **Example:** Variables and a secret file
 * ```typescript
 * export const MyEnv = Boat.Environment("MyEnv", {
 *   env: { NODE_ENV: "production", API_TOKEN: Config.Redacted("API_TOKEN") },
 *   secretFiles: [{ path: ".npmrc", contents: Config.Redacted("NPMRC") }],
 * });
 *
 * export const Box = Boat.Sandbox("Box", { environment: MyEnv });
 * ```
 *
 * **Example:** An environment for sandboxes you hand to users
 * ```typescript
 * export const Tenants = Boat.Environment("Tenants", { safeForThirdParties: true });
 * ```
 *
 * ### Passing account credentials
 * **Example:** Let sandboxes push to GitHub as you, and manage themselves
 * ```typescript
 * export const Mine = Boat.Environment("Mine", {
 *   passGithub: true,
 *   passSandboxCredentials: true,
 * });
 * ```
 *
 * ### Giving sandboxes AI credentials
 * **Example:** The keys of a credential profile
 * ```typescript
 * export const MyProfile = Boat.CredentialProfile("MyProfile", {
 *   anthropic: Config.Redacted("ANTHROPIC_API_KEY"),
 * });
 *
 * export const MyEnv = Boat.Environment("MyEnv", { credentialProfile: MyProfile });
 * ```
 *
 * **Example:** The sign-ins you made on the dashboard
 * ```typescript
 * export const MyEnv = Boat.Environment("MyEnv", {
 *   credentialProfile: Boat.CredentialProfile.lookup({ name: "default" }),
 * });
 * ```
 *
 * **Example:** Placeholders, for sandboxes you hand to users
 * ```typescript
 * export const MyProfile = Boat.CredentialProfile("MyProfile", {
 *   anthropic: Config.Redacted("ANTHROPIC_API_KEY"),
 * });
 *
 * // Billed: $1 a day, plus $1 per 1,000 proxied requests.
 * export const Proxy = Boat.AiProxy("Proxy", { enabled: true });
 *
 * export const Tenants = Boat.Environment("Tenants", {
 *   safeForThirdParties: true,
 *   credentialProfile: MyProfile,
 *   proxyAiCredentials: Proxy,
 * });
 * ```
 *
 * ### Sharing with an organization
 * **Example:** An environment the whole team uses
 * ```typescript
 * // alchemy.run.ts
 * export default Alchemy.Stack(
 *   "Team",
 *   { providers: Boat.providers({ org: "acme" }) },
 *   Effect.gen(function* () {
 *     const env = yield* Boat.Environment("MyEnv", { env: { MODE: "agent" } });
 *     return { environment: env.name };
 *   }),
 * );
 * ```
 *
 * ### Referencing an environment the stack doesn't manage
 * **Example:** Look one up by name
 * ```typescript
 * export const Box = Boat.Sandbox("Box", {
 *   environment: Boat.Environment.lookup({ name: "base" }),
 * });
 * ```
 *
 * @resource
 * @product Environment
 */
export const Environment = declarable<Environment>()(Resource<Environment>("Boat.Environment"));

const reveal = (value: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

/**
 * One `KEY=value` line as Boat reads it: single quotes keep a value
 * verbatim; double quotes are stripped without escapes. A value holding a
 * newline, or both kinds of quote, has no form Boat reads back intact.
 */
const envLine = (key: string, value: string) =>
  /^[A-Za-z0-9_./:@+,=%-]*$/.test(value)
    ? Effect.succeed(`${key}=${value}`)
    : value.includes("\n") || (value.includes("'") && value.includes('"'))
      ? Effect.fail(
          new InvalidEnvironmentValue({
            key,
            message: `Boat can't hold environment variable ${key}: its value has a newline, or both ' and "`,
          }),
        )
      : Effect.succeed(value.includes("'") ? `${key}="${value}"` : `${key}='${value}'`);

const envContentsOf = (env: EnvironmentProps["env"]) =>
  Effect.map(
    Effect.forEach(Object.entries(env ?? {}), ([key, value]) => envLine(key, reveal(value))),
    (lines) => lines.join("\n"),
  );

/** Boat writes secret files relative to the home directory and doesn't expand `~`. */
const relativePath = (path: string) => path.replace(/^~\//, "").replace(/^\/home\/user\//, "");

const secretFilesOf = (files: EnvironmentProps["secretFiles"]) =>
  (files ?? []).map((file) => ({
    path: relativePath(file.path),
    contents: reveal(file.contents),
  }));

const listEnvironments = Effect.fn(function* (org: string | undefined) {
  const { environments } = yield* boat.listEnvironments(inOrg(org));
  return environments;
});

const findEnvironment = Effect.fn(function* (
  org: string | undefined,
  match: { environmentId?: string; name: string },
) {
  const environments = yield* listEnvironments(org);
  return (
    environments.find((environment) => environment.id === match.environmentId) ??
    environments.find((environment) => environment.name === match.name)
  );
});

const toAttributes = (
  environment: boat.SandboxEnvironment,
  org: string | undefined,
): EnvironmentAttributes => ({
  environmentId: environment.id,
  name: environment.name,
  latestVersionNumber: environment.latestVersionNumber ?? 0,
  isDefault: environment.isDefault,
  org,
});

/**
 * What the props set, as the fields `updateEnvironment` takes. Nothing of
 * the account is passed unless a prop asks for it: Boat's own defaults pass
 * everything.
 */
const desiredOf = (name: string, news: EnvironmentProps, envContents: string) => ({
  name,
  envContents,
  secretFiles: secretFilesOf(news.secretFiles),
  safeForThirdParties: news.safeForThirdParties ?? false,
  passSecrets: news.passSecrets ?? true,
  passGithub: news.passGithub ?? false,
  passSandboxCredentials: news.passSandboxCredentials ?? false,
  passAgentsCredentials: news.passAgentsCredentials ?? news.credentialProfile !== undefined,
  proxyAiCredentials:
    typeof news.proxyAiCredentials === "object"
      ? news.proxyAiCredentials.enabled
      : (news.proxyAiCredentials ?? false),
  credentialProfileId: news.credentialProfile?.credentialProfileId ?? null,
});

const sortedFiles = (files: ReadonlyArray<{ path: string; contents: string }>) =>
  JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path)));

export const EnvironmentProvider = () =>
  Provider.effect(
    Environment,
    Effect.gen(function* () {
      return {
        stables: ["environmentId", "org"],
        // An environment belongs to one organization (or to you) for life.
        diff: Effect.fn(function* ({ output }) {
          if (output !== undefined && !sameOrg(output.org, yield* stackOrg)) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* boatName(id, olds?.name, 64));
          const org = output ? output.org : yield* stackOrg;
          const environment = yield* findEnvironment(org, {
            environmentId: output?.environmentId,
            name,
          });
          if (environment === undefined) return undefined;
          const attrs = toAttributes(environment, org);
          return output !== undefined || isGeneratedName(environment.name) ? attrs : Unowned(attrs);
        }),
        lookup: Effect.fn(function* ({ name }) {
          const org = yield* stackOrg;
          const environment = yield* findEnvironment(org, { name });
          return environment === undefined ? undefined : toAttributes(environment, org);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* boatName(id, news.name ?? output?.name, 64);
          // A different org replaces (see diff), so this is the org it lives in.
          const org = yield* stackOrg;

          // Observe — by id once we have one (it survives renames), else by name.
          let environment = yield* findEnvironment(org, {
            environmentId: output?.environmentId,
            name,
          });

          // Ensure — a concurrent create of the same name is a race, not a failure.
          if (environment === undefined) {
            yield* session.note(`Creating environment ${name}...`);
            const created = yield* boat
              .createEnvironment({ name, ...inOrg(org) })
              .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
            environment =
              created?.environments.find((candidate) => candidate.name === name) ??
              (yield* findEnvironment(org, { name }));
            if (environment === undefined) {
              return yield* new BoatUnexpectedResponse({
                message: `Boat environment ${name} vanished after create`,
              });
            }
          }

          // Sync — each update mints a version, so send only what differs.
          const desired = desiredOf(name, news, yield* envContentsOf(news.env));
          const delta: Partial<typeof desired> = {};
          if (environment.name !== desired.name) delta.name = desired.name;
          if (environment.envContents.trim() !== desired.envContents.trim()) {
            delta.envContents = desired.envContents;
          }
          if (sortedFiles(environment.secretFiles) !== sortedFiles(desired.secretFiles)) {
            delta.secretFiles = desired.secretFiles;
          }
          for (const flag of [
            "safeForThirdParties",
            "passGithub",
            "passSecrets",
            "passSandboxCredentials",
            "passAgentsCredentials",
          ] as const) {
            if (environment[flag] !== desired[flag]) delta[flag] = desired[flag];
          }
          if ((environment.proxyAiCredentials ?? false) !== desired.proxyAiCredentials) {
            delta.proxyAiCredentials = desired.proxyAiCredentials;
          }
          if ((environment.credentialProfileId ?? null) !== desired.credentialProfileId) {
            delta.credentialProfileId = desired.credentialProfileId;
          }
          const makeDefault = news.isDefault === true && !environment.isDefault;
          if (Object.keys(delta).length > 0 || makeDefault) {
            yield* session.note(`Updating environment ${name}...`);
            const updated = yield* boat.updateEnvironment({
              environmentId: environment.id,
              ...inOrg(org),
              ...delta,
              ...(makeDefault ? { isDefault: true } : {}),
            });
            environment = updated.environment ?? environment;
          }

          return toAttributes(environment, org);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* boat
            .deleteEnvironment({ environmentId: output.environmentId, ...inOrg(output.org) })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const org = yield* stackOrg;
          return (yield* listEnvironments(org))
            .filter((environment) => isGeneratedName(environment.name))
            .map((environment) => toAttributes(environment, org));
        }),
      };
    }),
  );
