import { expect } from "bun:test";
import * as Azure from "@alchemy.run/azure";
import * as app from "@distilled.cloud/azure/app";
import { Credentials } from "@distilled.cloud/azure/Credentials";
import * as web from "@distilled.cloud/azure/web";
import * as applications from "@distilled.cloud/microsoft-graph/applications";
import * as Alchemy from "alchemy";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Bun";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

/** The deployer's credentials, for out-of-band ARM and Microsoft Graph calls. */
const azure = Layer.mergeAll(
  Azure.environmentFromAuthProvider(),
  Azure.fromAuthProvider(),
  Azure.graphFromAuthProvider(),
).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

// A Consumption environment (free while idle), one 0.25 vCPU app that
// scales to zero, a Basic container registry, a Flex Consumption function
// app, and its Standard LRS storage account: a few cents per run. The
// environment takes 3-9 minutes to create and up to ~25 minutes to delete.
const stack = beforeAll(deploy(Stack), { timeout: 2_400_000 });

class Unexpected extends Data.TaggedError("Unexpected")<{
  readonly status: number;
  readonly body: string;
}> {}

/**
 * GET `url` (optionally with a bearer token) until it answers `expected`.
 * Retries through cold starts of both apps and the auth config reaching
 * the Quotes replicas after the first deploy. About 8 minutes when each
 * call fails fast.
 */
const getUntil = (url: string, expected: number, token?: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request =
      token === undefined
        ? HttpClientRequest.get(url)
        : HttpClientRequest.get(url).pipe(HttpClientRequest.bearerToken(token));
    const res = yield* client.execute(request).pipe(
      // A request to an app scaled to zero waits for a replica: bound it.
      Effect.timeout("30 seconds"),
      Effect.mapError((error) => new Unexpected({ status: 0, body: String(error) })),
    );
    const body = yield* res.text.pipe(
      Effect.mapError((error) => new Unexpected({ status: res.status, body: String(error) })),
    );
    if (res.status !== expected) return yield* new Unexpected({ status: res.status, body });
    return body;
  }).pipe(Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 45 }));

const trim = (url: string | undefined) => String(url).replace(/\/+$/, "");

/** Where the example's resources are, from the stack outputs. */
const where = Effect.gen(function* () {
  const outputs = yield* stack;
  const { subscriptionId } = yield* Azure.AzureEnvironment.current.pipe(Effect.provide(azure));
  return { subscriptionId, ...outputs };
});

type Where = Effect.Success<typeof where>;

/** A token for the Quotes audience, issued to the deployer (not the Gateway). */
const deployerToken = (audience: string) =>
  Effect.gen(function* () {
    const resolve = yield* Credentials;
    const config = yield* resolve;
    if (config.tokenFor === undefined) return Redacted.value(config.bearerToken);
    const token = yield* config.tokenFor(`${audience}/.default`);
    return Redacted.value(token);
  }).pipe(Effect.provide(azure));

const gone = () => Effect.succeed("gone" as const);

const containerAppStatus = (ids: Where) =>
  app
    .GetContainerApp({
      subscriptionId: ids.subscriptionId,
      resourceGroupName: ids.resourceGroup,
      containerAppName: ids.quotesAppName,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], gone),
      Effect.provide(azure),
    );

const functionAppStatus = (ids: Where) =>
  web
    .GetWebApp({
      subscriptionId: ids.subscriptionId,
      resourceGroupName: ids.resourceGroup,
      name: ids.gatewayAppName,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], gone),
      Effect.provide(azure),
    );

const environmentStatus = (ids: Where) =>
  app
    .GetManagedEnvironment({
      subscriptionId: ids.subscriptionId,
      resourceGroupName: ids.resourceGroup,
      environmentName: ids.environmentName,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], gone),
      Effect.provide(azure),
    );

const applicationStatus = (ids: Where) =>
  applications
    .getApplication({ applicationId: ids.apiObjectId })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("ResourceNotFound", gone),
      Effect.provide(azure),
    );

/** Poll until a deleted resource reads as gone (directory reads lag deletes). */
const untilGone = <E, R>(current: Effect.Effect<"found" | "gone", E, R>) =>
  current.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (s) => s === "gone",
      times: 30,
    }),
  );

afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const ids = yield* where;
    yield* destroy(Stack);
    expect(yield* untilGone(containerAppStatus(ids))).toBe("gone");
    expect(yield* untilGone(functionAppStatus(ids))).toBe("gone");
    expect(yield* untilGone(environmentStatus(ids))).toBe("gone");
    expect(yield* untilGone(applicationStatus(ids))).toBe("gone");
  }),
  // Deleting a Workload Profiles environment takes up to ~25 minutes.
  { timeout: 2_400_000 },
);

test(
  "the gateway is public",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(String(url)).toMatch(/^https:\/\//);
    expect(yield* getUntil(`${trim(url)}/`, 200)).toBe("ok");
  }),
  { timeout: 900_000 },
);

test(
  "Quotes rejects a request without a token with 401",
  Effect.gen(function* () {
    const { quotesUrl } = yield* stack;
    yield* getUntil(`${trim(quotesUrl)}/quote`, 401);
  }),
  { timeout: 900_000 },
);

test(
  "Quotes rejects a valid token for another principal with 403",
  Effect.gen(function* () {
    const { quotesUrl, apiAppId } = yield* stack;
    const token = yield* deployerToken(apiAppId);
    yield* getUntil(`${trim(quotesUrl)}/quote`, 403, token);
  }),
  { timeout: 900_000 },
);

test(
  "GET /quote on the gateway is served by Quotes as the gateway's managed identity",
  Effect.gen(function* () {
    const { url, gatewayPrincipalId } = yield* stack;
    const body = yield* getUntil(`${trim(url)}/quote?n=1`, 200);
    expect(JSON.parse(body)).toEqual({
      index: 1,
      quote: "Make it work, make it right, make it fast. — Kent Beck",
      servedBy: "quotes",
      caller: gatewayPrincipalId,
    });
  }),
  { timeout: 900_000 },
);

test(
  "the auth config admits only the gateway's identity for the QuotesApi audience",
  Effect.gen(function* () {
    const ids = yield* where;
    const config = yield* app
      .GetContainerAppsAuthConfig({
        subscriptionId: ids.subscriptionId,
        resourceGroupName: ids.resourceGroup,
        containerAppName: ids.quotesAppName,
        authConfigName: "current",
      })
      .pipe(Effect.provide(azure));
    expect(config.properties?.platform?.enabled).toBe(true);
    expect(config.properties?.globalValidation?.unauthenticatedClientAction).toBe("Return401");
    const aad = config.properties?.identityProviders?.azureActiveDirectory;
    expect(aad?.registration?.clientId).toBe(ids.apiAppId);
    expect(aad?.validation?.allowedAudiences).toEqual([ids.apiAppId]);
    expect(aad?.validation?.defaultAuthorizationPolicy?.allowedPrincipals?.identities).toEqual([
      ids.gatewayPrincipalId!,
    ]);
  }),
  { timeout: 120_000 },
);
