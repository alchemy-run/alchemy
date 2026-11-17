import * as DO from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { ignoreNotFound, noneIfNotFound } from "../internal/notFound.ts";
import type { Providers } from "../Providers.ts";

export type ProviderCredentialProps = {
  /** Provider slug from the Action Gateway catalog, like `abuseipdb`. A change replaces it. */
  provider: string;
  /**
   * The provider's API key. Rotates in place. Give either this or
   * `oauthClient`, or neither for an MCP provider that needs none.
   */
  apiKey?: Redacted.Redacted<string>;
  /** An OAuth client registered at the provider. The client ID can't change; the secret rotates in place. */
  oauthClient?: {
    readonly clientId: string;
    readonly clientSecret: Redacted.Redacted<string>;
    /** Your redirect URI registered at the provider. A change replaces it. @default DigitalOcean's callback */
    readonly redirectUrl?: string;
  };
  /** The provider API's HTTPS origin, for providers that take one. Updates in place. */
  baseUrl?: string;
  /**
   * Label, unique among the team's credentials for this provider. Updates
   * in place.
   *
   * @default a generated physical name
   */
  name?: string;
  /**
   * Share the credential with the whole team. Sharing can't be undone, so
   * turning it off replaces the credential.
   *
   * @default false
   */
  shared?: boolean;
};

export type ProviderCredential = Resource<
  "DigitalOcean.ActionGateway.ProviderCredential",
  ProviderCredentialProps,
  {
    /** Credential ID. */
    credentialId: string;
    /** Provider slug. */
    provider: string;
    /** Label. */
    name: string;
    /** `user` or `team`. */
    scope: string;
  },
  never,
  Providers
>;

export type ProviderCredentialAttributes = ProviderCredential["Attributes"];

/**
 * An API key or OAuth client for one Action Gateway catalog provider, which
 * connections to that provider then use. Secrets are write-only: DigitalOcean
 * never returns them.
 *
 * ### Registering a Credential
 * **Example:** An API key
 * ```typescript
 * const apiKey = yield* Config.Redacted("ABUSEIPDB_API_KEY");
 * yield* DigitalOcean.ActionGateway.ProviderCredential("AbuseIpDb", {
 *   provider: "abuseipdb",
 *   apiKey,
 * });
 * ```
 *
 * **Example:** An OAuth client, shared with the team
 * ```typescript
 * const clientSecret = yield* Config.Redacted("GITHUB_CLIENT_SECRET");
 * yield* DigitalOcean.ActionGateway.ProviderCredential("GitHub", {
 *   provider: "github",
 *   oauthClient: { clientId: "Iv1.abc123", clientSecret },
 *   shared: true,
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Action-Gateway
 *
 * @resource
 * @product Action Gateway
 * @category AI
 */
export const ProviderCredential = Resource<ProviderCredential>(
  "DigitalOcean.ActionGateway.ProviderCredential",
);

const physicalName = (id: string) => createPhysicalName({ id, maxLength: 64 });

const kindOf = (props: ProviderCredentialProps) =>
  props.apiKey !== undefined
    ? ("PROVIDER_CREDENTIAL_KIND_API_KEY" as const)
    : props.oauthClient !== undefined
      ? ("PROVIDER_CREDENTIAL_KIND_OAUTH_CLIENT" as const)
      : ("PROVIDER_CREDENTIAL_KIND_NONE" as const);

const reveal = (value: Redacted.Redacted<string> | undefined) =>
  value === undefined ? undefined : Redacted.value(value);

const observe = (id: string) =>
  noneIfNotFound(DO.getProviderCredentials({ id }).pipe(Effect.map((r) => r.credential))).pipe(
    Effect.map((c) =>
      Option.filter(
        c,
        (x): x is DO.ProviderCredential =>
          x !== undefined && x.status !== "PROVIDER_CREDENTIAL_STATUS_DELETED",
      ),
    ),
  );

const toAttrs = (c: DO.ProviderCredential): ProviderCredentialAttributes => ({
  credentialId: c.id ?? "",
  provider: c.provider ?? "",
  name: c.display_name ?? "",
  scope: c.scope ?? "user",
});

export const ProviderCredentialProvider = () =>
  Provider.succeed(ProviderCredential, {
    stables: ["credentialId", "provider"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const observed = yield* observe(output.credentialId);
      return Option.getOrUndefined(Option.map(observed, toAttrs));
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (
        news.provider !== olds.provider ||
        kindOf(news) !== kindOf(olds) ||
        news.oauthClient?.clientId !== olds.oauthClient?.clientId ||
        news.oauthClient?.redirectUrl !== olds.oauthClient?.redirectUrl ||
        (olds.shared === true && news.shared !== true)
      ) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const name = news.name ?? output?.name ?? (yield* physicalName(id));
      const observed = output === undefined ? Option.none() : yield* observe(output.credentialId);

      if (Option.isNone(observed)) {
        const created = yield* DO.createProviderCredentials({
          provider: news.provider,
          kind: kindOf(news),
          display_name: name,
          api_key: reveal(news.apiKey),
          client_id: news.oauthClient?.clientId,
          client_secret: reveal(news.oauthClient?.clientSecret),
          redirect_url: news.oauthClient?.redirectUrl,
          base_url: news.baseUrl,
          reusable_by_team: news.shared,
        });
        return toAttrs(created.credential ?? {});
      }

      // Secrets are write-only, so a rotation is seen against the props.
      const current = observed.value;
      const apiKey = reveal(news.apiKey);
      const clientSecret = reveal(news.oauthClient?.clientSecret);
      const rotateKey = apiKey !== undefined && apiKey !== reveal(olds?.apiKey);
      const rotateSecret =
        clientSecret !== undefined && clientSecret !== reveal(olds?.oauthClient?.clientSecret);
      const rename = current.display_name !== name;
      const rebase = news.baseUrl !== undefined && (current.base_url ?? "") !== news.baseUrl;
      const share = news.shared === true && current.reusable_by_team !== true;
      if (!rotateKey && !rotateSecret && !rename && !rebase && !share) return toAttrs(current);

      const updated = yield* DO.updateProviderCredentials({
        id: current.id ?? output!.credentialId,
        display_name: rename ? name : undefined,
        api_key: rotateKey ? apiKey : undefined,
        client_id:
          rotateSecret || (rebase && news.oauthClient) ? news.oauthClient?.clientId : undefined,
        client_secret: rotateSecret ? clientSecret : undefined,
        base_url: rebase ? news.baseUrl : undefined,
        reusable_by_team: share ? true : undefined,
      });
      return toAttrs(updated.credential ?? { ...current, display_name: name });
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteProviderCredentials({ id: output.credentialId }));
    }),
  });
