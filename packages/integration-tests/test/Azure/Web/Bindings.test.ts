import * as Azure from "@alchemy.run/azure";
import { Credentials } from "@distilled.cloud/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as web from "@distilled.cloud/azure/web";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import WebBindingsFunction, { Site } from "./fixtures/bindings-function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "AzureWebBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* WebBindingsFunction;
    const site = yield* Site;
    return {
      url: fn.url,
      principalId: fn.principalId,
      siteName: site.siteName,
      siteId: site.siteId,
      resourceGroup: site.resourceGroup,
    };
  }),
);

// Free (F1) App Service plan + Flex Consumption (~$0.01/run); ~5 min deploy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

/** Deployer credentials and environment for out-of-band checks. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: unknown; error?: string };

/**
 * Call a binding route until it answers `ok`, through the Flex Consumption
 * cold start and role propagation (about 4 minutes), then return the last
 * answer so a real failure shows its Azure error.
 */
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.execute(HttpClientRequest.get(`${url}${route}`)).pipe(
      Effect.timeout("60 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((json) => json as Body),
      Effect.flatMap((json) => (json?.ok ? Effect.succeed(json) : Effect.fail(json))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 48 }),
      Effect.catch((json) => Effect.succeed(json as Body)),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

/** The bound app, read as the deployer. */
const getSite = Effect.gen(function* () {
  const { siteName, resourceGroup } = yield* stack;
  const { subscriptionId } = yield* Azure.AzureEnvironment.current;
  return yield* web.GetWebApp({ subscriptionId, resourceGroupName: resourceGroup, name: siteName });
});

const siteState = (site: web.GetWebAppResponse) => site.properties?.state;

/**
 * `sites/restart/action` events of the app in the activity log since
 * `since`, read as the deployer: `{ status, caller }` per finished event.
 */
const restartEvents = (siteId: string, since: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const config = yield* yield* Credentials;
    // `bearerToken` is the ARM token.
    const token = config.bearerToken;
    const filter = `eventTimestamp ge '${since}' and resourceUri eq '${siteId}'`;
    const response = yield* HttpClient.execute(
      HttpClientRequest.get(
        `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.Insights/eventtypes/management/values`,
      ).pipe(
        HttpClientRequest.setUrlParams({ "api-version": "2015-04-01", $filter: filter }),
        HttpClientRequest.bearerToken(Redacted.value(token)),
      ),
    );
    const body = (yield* response.json) as {
      value?: {
        operationName?: { value?: string };
        status?: { value?: string };
        claims?: Record<string, string>;
      }[];
    };
    return (body.value ?? [])
      .filter((e) => e.operationName?.value?.toLowerCase() === "microsoft.web/sites/restart/action")
      .map((e) => ({
        status: e.status?.value,
        caller: e.claims?.["http://schemas.microsoft.com/identity/claims/objectidentifier"],
      }));
  }).pipe(Effect.provide(azure));

/** Read the app until `until` holds (bounded: about 5 minutes). */
const siteUntil = (until: (site: web.GetWebAppResponse) => boolean) =>
  getSite.pipe(
    Effect.repeat({ schedule: Schedule.spaced("10 seconds"), until, times: 30 }),
    Effect.provide(azure),
  );

/** Role assignments of the Function's identity, without its own host-storage grants. */
const assignmentsOf = (principalId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const assignments = yield* Stream.runCollect(
      authorization.ListRoleAssignmentForSubscription.items({
        subscriptionId,
        _filter: `principalId eq '${principalId}'`,
      }),
    );
    return Array.from(assignments).filter(
      (a) => !/\/storageaccounts\/[^/]+$/.test(a.properties?.scope?.toLowerCase() ?? ""),
    );
  });

/** Every role on the Function's identity as `<actions> <scope>`. */
const grantsOf = (principalId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const grants: string[] = [];
    for (const assignment of yield* assignmentsOf(principalId)) {
      const scope = assignment.properties?.scope?.toLowerCase() ?? "";
      const definition = yield* authorization.GetRoleDefinition({
        scope: `/subscriptions/${subscriptionId}`,
        roleDefinitionId: assignment.properties?.roleDefinitionId?.split("/").pop() ?? "",
      });
      const actions = (definition.properties?.permissions ?? [])
        .flatMap((p) => [...(p.actions ?? []), ...(p.dataActions ?? [])])
        .sort()
        .join("+");
      grants.push(`${actions} ${scope}`);
    }
    return grants.sort();
  });

describe.sequential(
  "App Service runtime-action bindings on an Azure Function",
  { tags: ["provider:azure", "live"] },
  () => {
    describe("Web.StopWebApp", () => {
      test(
        "stops the running app",
        Effect.gen(function* () {
          const running = yield* siteUntil((site) => siteState(site) === "Running");
          expect(siteState(running)).toEqual("Running");
          expectOk(yield* call("/stop"));
          const stopped = yield* siteUntil((site) => siteState(site) === "Stopped");
          expect(siteState(stopped)).toEqual("Stopped");
        }),
        { timeout: 900_000 },
      );
    });

    describe("Web.StartWebApp", () => {
      test(
        "starts the stopped app",
        Effect.gen(function* () {
          expectOk(yield* call("/start"));
          const running = yield* siteUntil((site) => siteState(site) === "Running");
          expect(siteState(running)).toEqual("Running");
        }),
        { timeout: 600_000 },
      );
    });

    describe("Web.RestartWebApp", () => {
      test(
        "restarts the app as the Function's identity",
        Effect.gen(function* () {
          const { siteId, principalId } = yield* stack;
          const since = new Date(Date.now() - 60_000).toISOString();
          expectOk(yield* call("/restart"));
          // ARM exposes no restart time on the site; the activity log records the
          // action, its caller, and its outcome (it trails by a few minutes).
          const events = yield* restartEvents(siteId, since).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("20 seconds"),
              until: (events) => events.some((e) => e.status === "Succeeded"),
              times: 45,
            }),
          );
          expect(events.find((e) => e.status === "Succeeded")).toEqual({
            status: "Succeeded",
            caller: principalId,
          });
          const running = yield* siteUntil((site) => siteState(site) === "Running");
          expect(siteState(running)).toEqual("Running");
        }),
        { timeout: 1_200_000 },
      );
    });

    describe("least privilege", () => {
      test(
        "each binding is one custom role with its one action, on the app only",
        Effect.gen(function* () {
          const outputs = yield* stack;
          const site = outputs.siteId.toLowerCase();
          const expected = [
            `Microsoft.Web/sites/restart/action ${site}`,
            `Microsoft.Web/sites/start/action ${site}`,
            `Microsoft.Web/sites/stop/action ${site}`,
          ].sort();
          // The filtered assignment list can trail the assignments by seconds.
          const grants = yield* grantsOf(outputs.principalId!).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (listed) => listed.length >= expected.length,
              times: 12,
            }),
            Effect.provide(azure),
          );
          expect(grants).toEqual(expected);
        }),
        { timeout: 120_000 },
      );
    });
  },
);

// Destroy, then prove (the assignment list trails deletes by a minute or more) the app and every role assigned to the Function's identity are gone.
afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    // A failed deploy yields no outputs; destroy still cleans up what it created.
    const outputs = yield* stack;
    yield* destroy(Stack);
    const principalId = outputs?.principalId;
    expect(principalId).toMatch(/^[0-9a-f-]{36}$/);
    const remaining = yield* assignmentsOf(principalId!).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("10 seconds"),
        until: (assignments) => assignments.length === 0,
        times: 24,
      }),
    );
    expect(remaining.map((a) => a.properties?.scope)).toEqual([]);
    const site = yield* getSite.pipe(
      Effect.as("found" as const),
      Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound", "NotFound"], () =>
        Effect.succeed("gone" as const),
      ),
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (status) => status === "gone",
        times: 12,
      }),
    );
    expect(site).toEqual("gone");
  }).pipe(Effect.provide(azure)),
  { timeout: 900_000 },
);
