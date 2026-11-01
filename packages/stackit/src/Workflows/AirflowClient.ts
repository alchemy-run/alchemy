import type * as Redacted from "effect/Redacted";

/**
 * The OAuth2 client a binding calls Airflow's REST API with, of the identity provider the instance
 * is configured with: STACKIT's docs suggest a separate client using the `client_credentials`
 * grant. The provider has to issue it a token whose `aud` claim is one of the instance's
 * `identityProvider.apiAudience`, and the provider's roles claim decides what Airflow lets it do.
 */
export interface AirflowClient {
  /** The provider's OpenID configuration, ending in `/.well-known/openid-configuration`. */
  discoveryEndpoint: string;
  /** The client's id. */
  clientId: string;
  /** The client's secret. Pass it `Redacted`, such as from `Config.redacted`. */
  clientSecret: string | Redacted.Redacted<string>;
  /** Scopes to request, when the provider needs them to issue the instance's audience. */
  scope?: string;
}
