import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { getEnvRedactedRequired, getEnvRequired } from "../Auth/Env.ts";
import {
  makeStoredAuthProvider,
  storedSecret,
  storedValueText,
  type StoredAuthConfig,
} from "../Auth/StoredAuthProvider.ts";

export const FORGEJO_AUTH_PROVIDER_NAME = "Forgejo";

export type ForgejoAuthConfig = StoredAuthConfig;

/**
 * Credentials resolved for a Forgejo instance, from either the selected
 * profile or the CI environment.
 */
export type ForgejoResolvedCredentials = {
  type: "token";
  /** Instance origin or API v1 base URL, as entered. */
  baseUrl: string;
  token: Redacted.Redacted<string>;
  source: { type: ForgejoAuthConfig["method"] | "env"; details?: string };
};

/**
 * Forgejo is self-hosted, so — unlike a single-tenant SaaS — the instance
 * URL is part of the credential rather than a constant. It is collected
 * alongside the token and stored with it, so one profile names both which
 * instance to talk to and how to authenticate against it.
 */
const validateBaseUrl = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? undefined
      : "Must be an http(s) URL.";
  } catch {
    return "Must be a valid URL, e.g. https://git.example.com";
  }
};

const forgejoAuth = makeStoredAuthProvider<ForgejoResolvedCredentials>({
  provider: FORGEJO_AUTH_PROVIDER_NAME,
  storageKey: "forgejo-stored",
  fields: [
    {
      name: "baseUrl",
      label: "Forgejo Instance URL",
      description:
        "Origin of your Forgejo instance, e.g. https://git.example.com",
      placeholder: "https://git.example.com",
      validate: validateBaseUrl,
    },
    {
      name: "token",
      label: "Forgejo Access Token",
      description:
        "Settings -> Applications -> Access Tokens on your instance.",
      secret: true,
    },
  ],
  toResolved: (values) => ({
    type: "token",
    baseUrl: storedValueText(values.baseUrl) ?? "",
    token: storedSecret(values.token) ?? Redacted.make(""),
    source: { type: "stored" },
  }),
  readEnvironment: Effect.all({
    baseUrl: getEnvRequired("FORGEJO_URL"),
    token: getEnvRedactedRequired("FORGEJO_TOKEN"),
  }).pipe(
    Effect.map(({ baseUrl, token }) => ({
      type: "token" as const,
      baseUrl,
      token,
      source: { type: "env" as const },
    })),
  ),
  environment: [
    {
      name: "FORGEJO_URL",
      description: "Forgejo instance origin or API v1 base URL.",
      required: true,
    },
    {
      name: "FORGEJO_TOKEN",
      description: "Forgejo access token.",
      required: true,
      secret: true,
    },
  ],
});

/**
 * Layer that registers the Forgejo `AuthProvider` into the `AuthProviders`
 * registry, making it configurable with `alchemy profile edit --add Forgejo`.
 */
export const ForgejoAuth = forgejoAuth.layer;
