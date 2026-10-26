# Azure service to service

An Azure Function calls a private Container App with its managed
identity. No secret or API key exists anywhere: the Function asks Microsoft
Entra ID for a token, and the Container App's built-in authentication
(Easy Auth) checks it before the request reaches the container.

| Runtime   | Kind                     | Access  | Routes                                    |
| --------- | ------------------------ | ------- | ----------------------------------------- |
| `Gateway` | `Azure.Functions.Function` | public  | `GET /` (health), `GET /quote?n=` (proxy) |
| `Quotes`  | `Azure.ContainerApps.ContainerApp` | private | `GET /quote?n=`                           |

```sh
curl "$url/quote?n=1"       # 200, served by Quotes through the gateway
curl "$quotesUrl/quote"     # 401, no token
```

## Architecture

- [`QuotesApi`](./src/resources.ts) is an `Azure.Entra.Application` with
  its `Azure.Entra.ServicePrincipal`. Its `appId` is the token audience
  that stands for the Quotes API.
- [`Quotes`](./src/Quotes.ts) is a Container App in its Effect form. The
  class is a tag and `Quotes.make(props, program)` is its implementation,
  provided to the stack. The Gateway yields the tag, so its bundle reads
  Quotes' URL without running Quotes' program.
- [`Gateway`](./src/Gateway.ts) is a Flex Consumption Function. Init reads
  `quotes.url` and `api.appId`. Per request, it gets a token for
  `<appId>/.default` from its system-assigned managed identity and sends
  it as `Authorization: Bearer`.
- `QuotesAuth` in [`alchemy.run.ts`](./alchemy.run.ts) is the
  `Azure.ContainerApps.AuthConfig` of Quotes:

```ts
yield* Azure.ContainerApps.AuthConfig("QuotesAuth", {
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
```

| Request to Quotes                                   | Answer |
| --------------------------------------------------- | ------ |
| no token                                            | `401`  |
| a token for the audience, issued to anyone else     | `403`  |
| a token for the audience, issued to the Gateway     | `200`  |

Easy Auth sets `x-ms-client-principal-id` to the caller's object ID, and
Quotes echoes it as `caller`, so the response shows which identity called.

The Container Apps resources run in `westus2`. The Function runs in the
profile's location. Every resource goes in the stack's resource group
(`<stack>-<stage>`); the Entra application lives in the tenant.

## Cost and time

A few cents per run: the Consumption environment is free while idle, the
0.25 vCPU app scales to zero, the Function bills per execution, and the
Basic registry and the storage account bill by the hour and by use. Entra
applications are free. The environment takes 3-9 minutes to create and up
to ~25 minutes to delete, so a full test run takes about 45 minutes.

The deploying service principal needs the Microsoft Graph permission
`Application.ReadWrite.OwnedBy` to create the Entra application (see
[Azure setup](https://alchemy.run/azure/setup)).

## Deploy

From the repository root:

```sh
pnpm install
cd examples/azure-service-to-service
pnpm deploy --profile <name>
```

The stack outputs `url` (the gateway) and `quotesUrl`.

## Live test

```sh
ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack and checks that:

- the gateway answers `200` with a quote from Quotes, whose `caller` is
  the gateway's managed identity;
- a direct call to Quotes without a token gets `401`;
- a direct call with the deployer's own token for the audience gets `403`;
- the auth config (read out of band) admits only the gateway's identity.

It then destroys the stack and checks that the container app, the
environment, the function app, and the Entra application are gone.

## Destroy

```sh
pnpm destroy --profile <name>
```
