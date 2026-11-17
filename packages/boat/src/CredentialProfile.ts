import * as boat from "@distilled.cloud/boat-dev/boat";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { BoatUnexpectedResponse } from "./Errors.ts";
import { inOrg, isOrgAccount, sameOrg, stackOrg } from "./internal/Org.ts";
import { boatName, isGeneratedName } from "./internal/Ownership.ts";
import type { Providers } from "./Providers.ts";

type Secret = string | Redacted.Redacted<string>;

/** A secret for any HTTPS API, and the base URL it is sent to. */
export interface CredentialProfileApi {
  /** The secret. A sandbox gets it as the variable the API is named after. */
  key: Secret;
  /**
   * The API's base URL: HTTPS on the default port, with a public DNS name.
   * A sandbox gets it as `<NAME>_BASE_URL`, and code there must send its
   * requests to that variable: with the AI credentials proxy on it holds
   * the proxy's URL, and only the proxy can swap the placeholder for `key`.
   */
  baseUrl: string;
}

export interface CredentialProfileProps {
  /**
   * Profile name, unique among its owner's profiles. If omitted, a unique
   * name is generated from the stack, stage and logical ID. Renamed in
   * place.
   */
  name?: string;
  /** Anthropic API key. Sandboxes get it as `ANTHROPIC_API_KEY`. */
  anthropic?: Secret;
  /** OpenAI API key. Sandboxes get it as `OPENAI_API_KEY`. */
  openai?: Secret;
  /** OpenRouter API key. */
  openrouter?: Secret;
  /** LLM Gateway API key. */
  llmgateway?: Secret;
  /** DeepSeek API key. */
  deepseek?: Secret;
  /** Moonshot API key. */
  moonshot?: Secret;
  /** Mistral API key. */
  mistral?: Secret;
  /** xAI API key. */
  xai?: Secret;
  /** OpenCode API key. */
  opencode?: Secret;
  /**
   * Secrets for any other HTTPS API, keyed by the environment variable a
   * sandbox gets the secret as: `A-Z`, `0-9` and `_`, up to 64 characters.
   * Provider names (`ANTHROPIC_*`, `OPENAI_*`, `AWS_*`, …) and names ending
   * in `_BASE_URL` are reserved.
   */
  apis?: Record<string, CredentialProfileApi>;
}

export interface CredentialProfileAttributes {
  /** Boat's profile id. */
  credentialProfileId: string;
  name: string;
  /**
   * The organization that owns the profile, as the stack's `org` named it;
   * `undefined` for a personal profile.
   */
  org: string | undefined;
  /** Whether it is its owner's default: what a sandbox gets when its environment names no profile. */
  isDefault: boolean;
  /** The credentials it holds, by Boat's ids (`anthropic-api-key`, `claude-subscription`, …). */
  connected: string[];
  /** The names of its custom APIs. */
  customApis: string[];
}

export interface CredentialProfile extends Resource<
  "Boat.CredentialProfile",
  CredentialProfileProps,
  CredentialProfileAttributes,
  never,
  Providers,
  { name: string }
> {}

/**
 * A Boat credential profile: a named set of API keys that Boat stores
 * encrypted and hands to the sandboxes of an environment that names it.
 *
 * A profile holds provider API keys (Anthropic, OpenAI, …) and custom APIs:
 * a secret for any other HTTPS API, with the base URL it is sent to. Boat
 * never returns a secret once it is stored.
 *
 * The API keys and custom APIs of a declared profile are exactly the ones
 * its props list: a deploy removes any other. Sign-ins (a Claude or ChatGPT
 * subscription) and Bedrock are connected on Boat's dashboard and left
 * alone.
 *
 * A profile is personal, or owned by an organization. With an `org` on the
 * stack (`Boat.providers({ org })`, or the profile's) the organization owns
 * it: every member's sandboxes can use it, and only owners change it.
 * Without one it is yours. Changing the stack's `org` replaces it.
 *
 * ### Creating a profile
 * **Example:** Provider API keys
 * ```typescript
 * export const MyProfile = Boat.CredentialProfile("MyProfile", {
 *   anthropic: Config.Redacted("ANTHROPIC_API_KEY"),
 *   openai: Config.Redacted("OPENAI_API_KEY"),
 * });
 * ```
 *
 * **Example:** A secret for any other API
 * ```typescript
 * export const Payments = Boat.CredentialProfile("Payments", {
 *   apis: {
 *     STRIPE_KEY: {
 *       key: Config.Redacted("STRIPE_KEY"),
 *       baseUrl: "https://api.stripe.com/v1",
 *     },
 *   },
 * });
 * ```
 *
 * A sandbox gets `STRIPE_KEY` and `STRIPE_KEY_BASE_URL`. Send requests to
 * `$STRIPE_KEY_BASE_URL`, not to the API's own address, so the same code
 * works when the AI credentials proxy replaces both.
 *
 * ### Giving sandboxes a profile
 * **Example:** Name it on an environment
 * ```typescript
 * export const MyProfile = Boat.CredentialProfile("MyProfile", {
 *   anthropic: Config.Redacted("ANTHROPIC_API_KEY"),
 * });
 *
 * export const MyEnv = Boat.Environment("MyEnv", { credentialProfile: MyProfile });
 *
 * export const Box = Boat.Sandbox("Box", { environment: MyEnv });
 * ```
 *
 * **Example:** Placeholders instead of real keys
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
 * ### Referencing a profile the stack doesn't manage
 * **Example:** The default profile, with the sign-ins made on the dashboard
 * ```typescript
 * export const MyEnv = Boat.Environment("MyEnv", {
 *   credentialProfile: Boat.CredentialProfile.lookup({ name: "default" }),
 * });
 * ```
 *
 * @resource
 * @product Credential Profile
 */
export const CredentialProfile = Resource<CredentialProfile>("Boat.CredentialProfile");

/** Props that hold a provider API key, and the credential Boat stores each as. */
const PROVIDER_KEYS = {
  anthropic: "anthropic-api-key",
  openai: "openai-api-key",
  openrouter: "openrouter-api-key",
  llmgateway: "llmgateway-api-key",
  deepseek: "deepseek-api-key",
  moonshot: "moonshot-api-key",
  mistral: "mistral-api-key",
  xai: "xai-api-key",
  opencode: "opencode-api-key",
} as const satisfies Partial<Record<keyof CredentialProfileProps, boat.CredentialId>>;

const providerKeys = Object.entries(PROVIDER_KEYS) as Array<
  [keyof typeof PROVIDER_KEYS, (typeof PROVIDER_KEYS)[keyof typeof PROVIDER_KEYS]]
>;

const reveal = (value: Secret | undefined) =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

/** The profiles of the stack's owner: the organization, or you. */
const listProfiles = Effect.fn(function* (org: string | undefined) {
  const { profiles } = yield* boat.listCredentialProfiles({});
  return profiles.filter((profile) => isOrgAccount(profile.owner, org));
});

const findProfile = Effect.fn(function* (
  org: string | undefined,
  match: { credentialProfileId?: string; name: string },
) {
  const profiles = yield* listProfiles(org);
  return (
    profiles.find((profile) => profile.id === match.credentialProfileId) ??
    profiles.find((profile) => profile.name === match.name)
  );
});

const toAttributes = (
  profile: boat.CredentialProfile,
  org: string | undefined,
): CredentialProfileAttributes => ({
  credentialProfileId: profile.id,
  name: profile.name,
  org,
  isDefault: profile.isDefault,
  connected: [...profile.connected],
  customApis: [...profile.customApis],
});

export const CredentialProfileProvider = () =>
  Provider.effect(
    CredentialProfile,
    Effect.gen(function* () {
      return {
        stables: ["credentialProfileId", "org"],
        // A profile belongs to one organization (or to you) for life.
        diff: Effect.fn(function* ({ output }) {
          if (output !== undefined && !sameOrg(output.org, yield* stackOrg)) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* boatName(id, olds?.name, 64));
          const org = output ? output.org : yield* stackOrg;
          const profile = yield* findProfile(org, {
            credentialProfileId: output?.credentialProfileId,
            name,
          });
          if (profile === undefined) return undefined;
          const attrs = toAttributes(profile, org);
          return output !== undefined || isGeneratedName(profile.name) ? attrs : Unowned(attrs);
        }),
        lookup: Effect.fn(function* ({ name }) {
          const org = yield* stackOrg;
          const profile = yield* findProfile(org, { name });
          return profile === undefined ? undefined : toAttributes(profile, org);
        }),
        reconcile: Effect.fn(function* ({ id, news, olds, output, session }) {
          const name = yield* boatName(id, news.name ?? output?.name, 64);
          // A different org replaces (see diff), so this is the org that owns it.
          const org = yield* stackOrg;

          // Observe — by id once we have one (it survives renames), else by name.
          let profile = yield* findProfile(org, {
            credentialProfileId: output?.credentialProfileId,
            name,
          });

          // Ensure — a concurrent create of the same name is a race, not a failure.
          if (profile === undefined) {
            yield* session.note(`Creating credential profile ${name}...`);
            const created = yield* boat
              // Without an `org`, the profile is yours.
              .createCredentialProfile({ name, ...inOrg(org) })
              .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
            profile = created?.profile ?? (yield* findProfile(org, { name }));
            if (profile === undefined) {
              return yield* new BoatUnexpectedResponse({
                message: `Boat credential profile ${name} vanished after create`,
              });
            }
          }

          // Sync the name.
          if (profile.name !== name) {
            profile = (yield* boat.updateCredentialProfile({ profile: profile.id, name })).profile;
          }

          // Sync provider keys. Boat never returns a key, so what it holds is
          // observed (`connected`) and the value is compared with the one last
          // deployed. An adopted profile has none, so every key is written.
          for (const [prop, credential] of providerKeys) {
            const value = reveal(news[prop]);
            if (value === undefined) {
              if (profile.connected.includes(credential)) {
                profile =
                  (yield* boat
                    .deleteCredentialProfileKey({ profile: profile.id, credential })
                    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined))))?.profile ??
                  profile;
              }
            } else if (
              olds === undefined ||
              !profile.connected.includes(credential) ||
              reveal(olds[prop]) !== value
            ) {
              profile = (yield* boat.setCredentialProfileKey({
                profile: profile.id,
                credential,
                value,
              })).profile;
            }
          }

          // Sync custom APIs, the same way.
          const apis = news.apis ?? {};
          for (const apiName of profile.customApis) {
            if (apiName in apis) continue;
            profile =
              (yield* boat
                .deleteCredentialProfileCustomApi({ profile: profile.id, name: apiName })
                .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined))))?.profile ??
              profile;
          }
          for (const [apiName, api] of Object.entries(apis)) {
            const old = olds?.apis?.[apiName];
            if (
              old !== undefined &&
              profile.customApis.includes(apiName) &&
              reveal(old.key) === reveal(api.key) &&
              old.baseUrl === api.baseUrl
            ) {
              continue;
            }
            profile = (yield* boat.setCredentialProfileCustomApi({
              profile: profile.id,
              name: apiName,
              value: reveal(api.key) ?? "",
              baseUrl: api.baseUrl,
            })).profile;
          }

          return toAttributes(profile, org);
        }),
        // An environment that still names the profile fails the delete with
        // Boat's own `in_use`; the engine deletes dependents first.
        delete: Effect.fn(function* ({ output }) {
          yield* boat
            .deleteCredentialProfile({ profile: output.credentialProfileId })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const org = yield* stackOrg;
          return (yield* listProfiles(org))
            .filter((profile) => isGeneratedName(profile.name))
            .map((profile) => toAttributes(profile, org));
        }),
      };
    }),
  );
