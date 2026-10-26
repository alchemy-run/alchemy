import { expect } from "bun:test";
import * as Azure from "@alchemy.run/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as compute from "@distilled.cloud/azure/compute";
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

// One 1-vCPU F-series v7 VM (~$0.04/hour), a Standard public IP
// (~$0.005/hour), and two Standard LRS storage accounts for about 20
// minutes: well under $0.05 per run. The VM and its release take 5-10
// minutes to deploy.
const stack = beforeAll(deploy(Stack), { timeout: 1_800_000 });

class NotOk extends Data.TaggedError("NotOk")<{ readonly status: number; readonly body: string }> {}

/**
 * Call the API and expect `expected`. Retries while the role assignments
 * propagate after the first deploy (the API answers 500 until then) and
 * while the worker has not processed a job yet (404): 10 s apart, at most
 * 5 minutes.
 */
const call = (method: "GET" | "POST", path: string, expected: number, body?: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    const target = `${String(url).replace(/\/+$/, "")}${path}`;
    const request =
      method === "POST"
        ? HttpClientRequest.post(target).pipe(HttpClientRequest.bodyText(body ?? ""))
        : HttpClientRequest.get(target);
    const res = yield* client.execute(request).pipe(
      Effect.timeout("20 seconds"),
      Effect.mapError((error) => new NotOk({ status: 0, body: String(error) })),
    );
    const text = yield* res.text.pipe(
      Effect.mapError((error) => new NotOk({ status: res.status, body: String(error) })),
    );
    if (res.status !== expected) return yield* new NotOk({ status: res.status, body: text });
    return text;
  }).pipe(Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 30 }));

/** Where the example's resources are, from the stack outputs. */
const where = Effect.gen(function* () {
  const outputs = yield* stack;
  const { subscriptionId } = yield* Azure.AzureEnvironment.current.pipe(Effect.provide(azure));
  return { subscriptionId, ...outputs };
});

type Where = Effect.Success<typeof where>;

const getVm = (ids: Where) =>
  compute
    .GetVirtualMachine({
      subscriptionId: ids.subscriptionId,
      resourceGroupName: ids.resourceGroup,
      vmName: ids.vmName,
    })
    .pipe(Effect.provide(azure));

const vmStatus = (ids: Where) =>
  getVm(ids).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
  );

/** `scope|role GUID` of every role assignment `principalId` holds, sorted. */
const grantsOf = (ids: Where, principalId: string) =>
  authorization
    .ListRoleAssignmentForSubscription({
      subscriptionId: ids.subscriptionId,
      _filter: `principalId eq '${principalId}'`,
    })
    .pipe(
      Effect.map((page) =>
        page.value
          .map(
            (a) =>
              `${a.properties?.scope?.toLowerCase()}|${a.properties?.roleDefinitionId?.split("/").pop()}`,
          )
          .sort(),
      ),
      Effect.provide(azure),
    );

afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const ids = yield* where;
    yield* destroy(Stack);
    expect(
      yield* vmStatus(ids).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (s) => s === "gone",
          times: 30,
        }),
      ),
    ).toBe("gone");
    // Destroy revoked the bindings' grants (role assignments outlive their
    // principal). Reads trail deletes by up to a minute or two.
    expect(
      yield* grantsOf(ids, ids.principalId!).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (grants) => grants.length === 0,
          times: 18,
        }),
      ),
    ).toEqual([]);
  }),
  { timeout: 1_800_000 },
);

test(
  "the program answers on the VM's public IP",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(String(url)).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:3000$/);
    expect(yield* call("GET", "/", 200)).toBe("ok");
  }),
  { timeout: 600_000 },
);

test(
  "a job goes through the queue and the background worker writes its result",
  Effect.gen(function* () {
    const text = `hello from ${crypto.randomUUID()}`;
    const { id } = JSON.parse(yield* call("POST", "/jobs", 202, text)) as { id: string };
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(yield* call("GET", `/jobs/${id}`, 200)).toBe(text.toUpperCase());
  }),
  { timeout: 900_000 },
);

test(
  "an unknown job is 404",
  Effect.gen(function* () {
    expect(yield* call("GET", `/jobs/${crypto.randomUUID()}`, 404)).toBe("pending");
  }),
  { timeout: 600_000 },
);

test(
  "the VM runs the release as a system identity that holds only the bindings' roles",
  Effect.gen(function* () {
    const ids = yield* where;
    const vm = yield* getVm(ids);
    expect(vm.properties?.provisioningState).toBe("Succeeded");
    expect(vm.identity?.type).toBe("SystemAssigned");
    expect(vm.identity?.principalId).toBe(ids.principalId);

    const release = yield* compute
      .GetVirtualMachineRunCommandByVirtualMachine({
        subscriptionId: ids.subscriptionId,
        resourceGroupName: ids.resourceGroup,
        vmName: ids.vmName,
        runCommandName: "alchemy-release",
        _expand: "instanceView",
      })
      .pipe(Effect.provide(azure));
    expect(release.properties?.instanceView?.executionState).toBe("Succeeded");
    expect(release.properties?.instanceView?.exitCode).toBe(0);

    const role = Azure.Authorization.BuiltInRole;
    const expected = [
      `${ids.containerId.toLowerCase()}|${role.StorageBlobDataContributor}`,
      `${ids.queueId.toLowerCase()}|${role.StorageQueueDataMessageProcessor}`,
      `${ids.queueId.toLowerCase()}|${role.StorageQueueDataMessageSender}`,
    ].sort();
    // Role-assignment reads trail writes by up to a minute or two.
    expect(
      yield* grantsOf(ids, ids.principalId!).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (grants) => grants.length >= expected.length,
          times: 18,
        }),
      ),
    ).toEqual(expected);
  }),
  { timeout: 300_000 },
);
