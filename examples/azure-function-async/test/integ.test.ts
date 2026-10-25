import { expect } from "bun:test";
import * as Azure from "@alchemy.run/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as web from "@distilled.cloud/azure/web";
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
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

/** The deployer's credentials, for out-of-band ARM reads. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

// One Flex Consumption app (billed per execution) and two Standard_LRS
// storage accounts: a few cents per run, about 3 minutes.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

class Unexpected extends Data.TaggedError("Unexpected")<{
  readonly status: number;
  readonly body: string;
}> {}

/** Send one request to the deployed API. */
const send = (method: "GET" | "PUT", path: string, body?: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const target = `${String(url).replace(/\/+$/, "")}${path}`;
    const request =
      method === "PUT"
        ? HttpClientRequest.put(target).pipe(HttpClientRequest.bodyText(body ?? "", "text/plain"))
        : HttpClientRequest.get(target);
    const res = yield* HttpClient.execute(request);
    return { status: res.status, body: yield* res.text };
  });

/**
 * `send` until it answers `status`. The Flex Consumption cold start and the
 * container role propagating after the first deploy take a few minutes;
 * until then the API answers 5xx or 403.
 */
const expectStatus = (status: number, method: "GET" | "PUT", path: string, body?: string) =>
  send(method, path, body).pipe(
    Effect.flatMap((res) =>
      res.status === status ? Effect.succeed(res.body) : Effect.fail(new Unexpected(res)),
    ),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 48 }),
  );

/** Where the example's resources are, from the stack outputs. */
const where = Effect.gen(function* () {
  const outputs = yield* stack;
  const { subscriptionId } = yield* Azure.AzureEnvironment.current.pipe(Effect.provide(azure));
  return { subscriptionId, ...outputs };
});

type Where = Effect.Success<typeof where>;

const getSite = (ids: Where) =>
  web
    .GetWebApp({
      subscriptionId: ids.subscriptionId,
      resourceGroupName: ids.resourceGroup,
      name: ids.functionApp,
    })
    .pipe(Effect.provide(azure));

const getRoleAssignment = (ids: Where) =>
  authorization
    .GetRoleAssignment({ scope: ids.roleScope, roleAssignmentName: ids.roleAssignment })
    .pipe(Effect.provide(azure));

const siteStatus = (ids: Where) =>
  getSite(ids).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
  );

const roleAssignmentStatus = (ids: Where) =>
  getRoleAssignment(ids).pipe(
    Effect.as("found" as const),
    // The scope is the container, so a deleted resource group also means gone.
    Effect.catchTag(["RoleAssignmentNotFound", "ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
  );

/** Poll until a deleted resource reads as gone. */
const untilGone = <E, R>(status: Effect.Effect<"found" | "gone", E, R>) =>
  status.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (current) => current === "gone",
      times: 24,
    }),
  );

afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const ids = yield* where;
    yield* destroy(Stack);
    expect(yield* untilGone(siteStatus(ids))).toBe("gone");
    expect(yield* untilGone(roleAssignmentStatus(ids))).toBe("gone");
  }),
  { timeout: 900_000 },
);

test(
  "the function app runs Node.js 22 under a managed identity that holds the blob role",
  Effect.gen(function* () {
    const ids = yield* where;
    const site = yield* getSite(ids);
    expect(site.identity?.type).toBe("SystemAssigned");
    expect(site.properties?.functionAppConfig?.runtime?.name).toBe("node");
    expect(site.properties?.functionAppConfig?.runtime?.version).toBe("22");

    const assignment = yield* getRoleAssignment(ids);
    expect(assignment.properties?.principalId).toBe(site.identity?.principalId);
    expect(assignment.properties?.roleDefinitionId?.split("/").pop()).toBe(
      Azure.Authorization.BuiltInRole.StorageBlobDataContributor,
    );
  }),
  { timeout: 120_000 },
);

test(
  "GET / answers the greeting from env",
  Effect.gen(function* () {
    expect(yield* expectStatus(200, "GET", "/")).toBe("hello from Azure Functions");
  }),
  { timeout: 600_000 },
);

test(
  "a note round-trips through the blob container",
  Effect.gen(function* () {
    const text = `note ${crypto.randomUUID()}`;
    expect(yield* expectStatus(201, "PUT", "/notes/first.txt", text)).toBe("stored");
    expect(yield* expectStatus(200, "GET", "/notes/first.txt")).toBe(text);
  }),
  { timeout: 600_000 },
);

test(
  "a missing note answers 404",
  Effect.gen(function* () {
    expect(yield* expectStatus(404, "GET", "/notes/missing.txt")).toBe("Not Found");
  }),
  { timeout: 600_000 },
);
