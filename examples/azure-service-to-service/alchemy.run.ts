import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import Gateway from "./src/Gateway.ts";
import QuotesLive, { Quotes } from "./src/Quotes.ts";
import { Environment, QuotesApi, QuotesApiPrincipal } from "./src/resources.ts";

export default Alchemy.Stack(
  "AzureServiceToServiceExample",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const environment = yield* Environment;
    const api = yield* QuotesApi;
    const principal = yield* QuotesApiPrincipal;
    const quotes = yield* Quotes;
    const gateway = yield* Gateway;

    // Built-in authentication on Quotes: a request needs an Entra token for
    // the QuotesApi audience (else 401), issued to the Gateway's managed
    // identity (else 403).
    const auth = yield* Azure.ContainerApps.AuthConfig("QuotesAuth", {
      containerApp: quotes.containerAppName,
      platform: { enabled: true },
      globalValidation: { unauthenticatedClientAction: "Return401" },
      identityProviders: {
        azureActiveDirectory: {
          enabled: true,
          registration: {
            clientId: api.appId,
            openIdIssuer: Output.interpolate`https://sts.windows.net/${api.tenantId}/v2.0`,
          },
          validation: {
            allowedAudiences: [api.appId],
            defaultAuthorizationPolicy: {
              allowedPrincipals: { identities: [gateway.principalId.as<string>()] },
            },
          },
        },
      },
    });

    return {
      url: gateway.url,
      gatewayAppName: gateway.functionAppName,
      gatewayPrincipalId: gateway.principalId,
      quotesUrl: quotes.url,
      quotesAppName: quotes.containerAppName,
      resourceGroup: quotes.resourceGroup,
      environmentName: environment.environmentName,
      apiAppId: api.appId,
      apiObjectId: api.objectId,
      apiPrincipalId: principal.objectId,
      authEnabled: auth.enabled,
    };
  }).pipe(Effect.provide(QuotesLive)),
);
