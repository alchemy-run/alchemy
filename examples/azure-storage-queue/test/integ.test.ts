import { expect } from "bun:test";
import { createHash } from "node:crypto";
import * as Azure from "@alchemy.run/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as storage from "@distilled.cloud/azure/storage";
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

// Two Flex Consumption apps (billed per execution) and three Standard_LRS
// storage accounts: a few cents per run, about 5 minutes.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

const subscriptionId = Azure.AzureEnvironment.current.pipe(
  Effect.map((env) => env.subscriptionId),
  Effect.provide(azure),
);

const queueStatus = (resourceGroupName: string, accountName: string, queueName: string) =>
  Effect.gen(function* () {
    const id = yield* subscriptionId;
    return yield* storage
      .GetQueue({ subscriptionId: id, resourceGroupName, accountName, queueName })
      .pipe(
        Effect.as("found" as const),
        Effect.catchTag(["QueueNotFound", "ResourceNotFound", "ResourceGroupNotFound"], () =>
          Effect.succeed("gone" as const),
        ),
        Effect.provide(azure),
      );
  });

const containerStatus = (resourceGroupName: string, accountName: string, containerName: string) =>
  Effect.gen(function* () {
    const id = yield* subscriptionId;
    return yield* storage
      .GetBlobContainer({ subscriptionId: id, resourceGroupName, accountName, containerName })
      .pipe(
        Effect.as("found" as const),
        Effect.catchTag(["ContainerNotFound", "ResourceNotFound", "ResourceGroupNotFound"], () =>
          Effect.succeed("gone" as const),
        ),
        Effect.provide(azure),
      );
  });

const appStatus = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const id = yield* subscriptionId;
    return yield* web.GetWebApp({ subscriptionId: id, resourceGroupName, name }).pipe(
      Effect.as("found" as const),
      Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound", "NotFound"], () =>
        Effect.succeed("gone" as const),
      ),
      Effect.provide(azure),
    );
  });

/** `scope|roleGuid` for every role assignment of a principal. */
const roleAssignmentsOf = (principalId: string) =>
  Effect.gen(function* () {
    const id = yield* subscriptionId;
    const page = yield* authorization
      .ListRoleAssignmentForSubscription({
        subscriptionId: id,
        _filter: `principalId eq '${principalId}'`,
      })
      .pipe(Effect.provide(azure));
    return page.value.map(
      (a) =>
        `${a.properties?.scope?.toLowerCase()}|${a.properties?.roleDefinitionId?.split("/").pop()}`,
    );
  });

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
    const out = yield* stack;
    yield* destroy(Stack);
    expect(yield* untilGone(appStatus(out.resourceGroup, out.apiApp))).toBe("gone");
    expect(yield* untilGone(appStatus(out.resourceGroup, out.workerApp))).toBe("gone");
    expect(
      yield* untilGone(queueStatus(out.resourceGroup, out.storageAccount, out.queueName)),
    ).toBe("gone");
    expect(
      yield* untilGone(containerStatus(out.resourceGroup, out.storageAccount, out.containerName)),
    ).toBe("gone");
  }),
  { timeout: 900_000 },
);

class UnexpectedStatus extends Data.TaggedError("UnexpectedStatus")<{
  status: number;
  body: string;
}> {}

interface JobStatus {
  id: string;
  status: "pending" | "done";
  sha256?: string;
  words?: number;
  chars?: number;
}

/** Call the API; anything but `ok` fails, so callers can retry. */
const call = (request: HttpClientRequest.HttpClientRequest, ok: number[]) =>
  Effect.gen(function* () {
    const res = yield* HttpClient.execute(request);
    const body = yield* res.text;
    if (!ok.includes(res.status)) {
      return yield* new UnexpectedStatus({ status: res.status, body: body.slice(0, 500) });
    }
    return { status: res.status, body };
  });

const baseUrl = Effect.map(stack, ({ url }) => String(url).replace(/\/+$/, ""));

/**
 * Retry through the Flex Consumption cold start and the apps' data roles
 * propagating after the first deploy (5 s × 48, 4 minutes).
 */
const retryWarmup = Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 48 });

const PAYLOADS = [
  "hello world",
  "the quick brown fox jumps over the lazy dog",
  "  alchemy   on   azure  ",
  "one",
  "",
];

test(
  "the apps' identities hold only the queue roles their bindings ask for",
  Effect.gen(function* () {
    const out = yield* stack;
    const queueScope = out.queueId.toLowerCase();
    // Role-assignment lists trail new assignments by a few seconds.
    const onQueue = (principalId: string | undefined, count: number) =>
      roleAssignmentsOf(String(principalId)).pipe(
        Effect.map((all) => all.filter((a) => a.startsWith(`${queueScope}|`)).sort()),
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (onScope) => onScope.length >= count,
          times: 12,
        }),
      );
    const role = Azure.Authorization.BuiltInRole;

    expect(yield* onQueue(out.apiPrincipalId, 1)).toEqual([
      `${queueScope}|${role.StorageQueueDataMessageSender}`,
    ]);
    expect(yield* onQueue(out.workerPrincipalId, 2)).toEqual(
      [
        `${queueScope}|${role.StorageQueueDataMessageProcessor}`,
        `${queueScope}|${role.StorageQueueDataReader}`,
      ].sort(),
    );
  }),
  { timeout: 120_000 },
);

test(
  "rejects a job without a string payload",
  Effect.gen(function* () {
    const url = yield* baseUrl;
    yield* call(HttpClientRequest.get(`${url}/`), [200]).pipe(retryWarmup);
    const res = yield* call(
      HttpClientRequest.post(`${url}/jobs`).pipe(HttpClientRequest.bodyJsonUnsafe({ payload: 42 })),
      [400],
    );
    expect(res.status).toBe(400);
  }),
  { timeout: 360_000 },
);

test(
  "processes submitted jobs through the queue into blob storage",
  Effect.gen(function* () {
    const out = yield* stack;
    const url = yield* baseUrl;
    expect(yield* queueStatus(out.resourceGroup, out.storageAccount, out.queueName)).toBe("found");
    expect(yield* appStatus(out.resourceGroup, out.workerApp)).toBe("found");

    const ids: string[] = [];
    for (const payload of PAYLOADS) {
      const res = yield* call(
        HttpClientRequest.post(`${url}/jobs`).pipe(HttpClientRequest.bodyJsonUnsafe({ payload })),
        [202],
      ).pipe(retryWarmup);
      const body = JSON.parse(res.body) as JobStatus;
      expect(body.status).toBe("pending");
      ids.push(body.id);
    }

    // The worker's first poll after a cold start, and its blob role
    // propagating, can take a few minutes.
    const results = yield* Effect.forEach(ids, (id) =>
      call(HttpClientRequest.get(`${url}/jobs/${id}`), [200, 202]).pipe(
        retryWarmup,
        Effect.map((res) => JSON.parse(res.body) as JobStatus),
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (status) => status.status === "done",
          times: 36,
        }),
      ),
    );

    for (const [i, payload] of PAYLOADS.entries()) {
      expect(results[i]).toMatchObject({
        id: ids[i],
        status: "done",
        sha256: createHash("sha256").update(payload, "utf8").digest("hex"),
        words: payload.split(/\s+/).filter(Boolean).length,
        chars: payload.length,
      });
    }
  }),
  { timeout: 900_000 },
);
