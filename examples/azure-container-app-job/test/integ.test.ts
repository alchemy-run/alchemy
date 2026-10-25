import { expect } from "bun:test";
import * as Azure from "@alchemy.run/azure";
import * as app from "@distilled.cloud/azure/app";
import * as storage from "@distilled.cloud/azure/storage";
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
import { SCHEDULE, type Report } from "../src/resources.ts";

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

// A Consumption-profile Container Apps environment (no idle cost), a Basic
// container registry (~$0.17/day), a Flex Consumption function and a few
// 0.25 vCPU executions (inside the monthly free grants): a few cents per run.
// The environment takes 5-30 minutes to create and 5-25 minutes to delete.
const stack = beforeAll(deploy(Stack), { timeout: 2_400_000 });

class ServerError extends Data.TaggedError("ServerError")<{
  readonly status: number;
  readonly body: string;
}> {}

/** Call the deployed API; retries 5xx through cold start and role propagation. */
const call = (method: "GET" | "PUT", path: string, body?: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const target = `${String(url).replace(/\/+$/, "")}${path}`;
    const request =
      method === "PUT"
        ? HttpClientRequest.put(target).pipe(HttpClientRequest.bodyText(body ?? ""))
        : HttpClientRequest.get(target);
    const res = yield* HttpClient.execute(request);
    const text = yield* res.text;
    if (res.status >= 500) return yield* new ServerError({ status: res.status, body: text });
    return { status: res.status, text };
  }).pipe(
    // The Flex Consumption cold start, and the function's blob role
    // propagating after the first deploy, take a few minutes.
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 48 }),
  );

class NotReady extends Data.TaggedError("NotReady")<{ readonly status: number }> {}

/**
 * Wait until the API's own `GET /health` answers `ok`. Right after a deploy
 * the Functions host answers `404` for every route until it loads the code
 * (and it always serves its own landing page on `/`).
 */
const ready = call("GET", "/health").pipe(
  Effect.flatMap((res) =>
    res.status === 200 && res.text === "ok"
      ? Effect.void
      : Effect.fail(new NotReady({ status: res.status })),
  ),
  Effect.retry({
    while: (e) => e._tag === "NotReady",
    schedule: Schedule.spaced("5 seconds"),
    times: 48,
  }),
);

/** Where the example's resources are, from the stack outputs. */
const where = Effect.gen(function* () {
  const outputs = yield* stack;
  const { subscriptionId } = yield* Azure.AzureEnvironment.current.pipe(Effect.provide(azure));
  return { subscriptionId, resourceGroupName: outputs.resourceGroup, ...outputs };
});

type Where = Effect.Success<typeof where>;

const getJob = (ids: Where) =>
  app
    .GetJob({
      subscriptionId: ids.subscriptionId,
      resourceGroupName: ids.resourceGroupName,
      jobName: ids.jobName,
    })
    .pipe(Effect.provide(azure));

const executionsOf = (ids: Where) =>
  app
    .ListJobsExecutions({
      subscriptionId: ids.subscriptionId,
      resourceGroupName: ids.resourceGroupName,
      jobName: ids.jobName,
    })
    .pipe(
      Effect.map((page) => page.value),
      Effect.provide(azure),
    );

const found = Effect.as("found" as const);
const gone = () => Effect.succeed("gone" as const);

const jobStatus = (ids: Where) =>
  getJob(ids).pipe(found, Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], gone));

const environmentStatus = (ids: Where) =>
  app
    .GetManagedEnvironment({
      subscriptionId: ids.subscriptionId,
      resourceGroupName: ids.resourceGroupName,
      environmentName: ids.environmentName,
    })
    .pipe(
      found,
      Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], gone),
      Effect.provide(azure),
    );

const storageAccountStatus = (ids: Where) =>
  storage
    .GetStorageAccountProperties({
      subscriptionId: ids.subscriptionId,
      resourceGroupName: ids.resourceGroupName,
      accountName: ids.storageAccount,
    })
    .pipe(
      found,
      Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], gone),
      Effect.provide(azure),
    );

/** Poll until a deleted resource reads as gone. */
const untilGone = <E, R>(status: Effect.Effect<"found" | "gone", E, R>) =>
  status.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (current) => current === "gone",
      times: 30,
    }),
  );

afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const ids = yield* where;
    yield* destroy(Stack);
    expect(yield* untilGone(jobStatus(ids))).toBe("gone");
    expect(yield* untilGone(environmentStatus(ids))).toBe("gone");
    expect(yield* untilGone(storageAccountStatus(ids))).toBe("gone");
  }),
  { timeout: 2_400_000 },
);

test(
  "the job runs on its cron schedule with a managed identity",
  Effect.gen(function* () {
    const ids = yield* where;
    const job = yield* getJob(ids);
    expect(job.properties?.configuration?.triggerType).toBe("Schedule");
    expect(job.properties?.configuration?.scheduleTriggerConfig?.cronExpression).toBe(SCHEDULE);
    expect(job.identity?.type).toBe("SystemAssigned");
    expect(job.properties?.configuration?.registries?.[0]?.identity).toBe("system");
  }),
  { timeout: 120_000 },
);

test(
  "the API rejects an invalid file name",
  Effect.gen(function* () {
    yield* ready;
    const res = yield* call("PUT", "/files/bad%20name", "x");
    expect(res.status).toBe(400);
  }),
  { timeout: 600_000 },
);

const FILES: Record<string, string> = {
  "a.txt": "hello",
  "b.txt": "scheduled",
  "c.txt": "container apps job",
};

test(
  "a scheduled execution reports the uploaded files",
  Effect.gen(function* () {
    yield* ready;
    for (const [name, body] of Object.entries(FILES)) {
      const res = yield* call("PUT", `/files/${name}`, body);
      expect(res.status).toBe(201);
    }
    const count = Object.keys(FILES).length;
    const bytes = Object.values(FILES).reduce((sum, body) => sum + body.length, 0);

    // Executions start every minute; the first ones can fail while the
    // job's blob role propagates. Wait for a report that counts the files.
    const report = yield* call("GET", "/report").pipe(
      Effect.map((res) => (res.status === 200 ? (JSON.parse(res.text) as Report) : undefined)),
      Effect.repeat({
        schedule: Schedule.spaced("15 seconds"),
        until: (r) => r?.files === count,
        times: 60,
      }),
    );
    expect(report?.files).toBe(count);
    expect(report?.bytes).toBe(bytes);

    // Out of band: the execution that wrote the report is one of the job's,
    // and it succeeded.
    const ids = yield* where;
    expect(report?.execution).toMatch(new RegExp(`^${ids.jobName}-[a-z0-9]+$`));
    const status = yield* executionsOf(ids).pipe(
      Effect.map(
        (executions) => executions.find((e) => e.name === report?.execution)?.properties?.status,
      ),
      // The report is written just before the execution finishes.
      Effect.repeat({
        schedule: Schedule.spaced("10 seconds"),
        until: (s) => s === "Succeeded" || s === "Failed",
        times: 18,
      }),
    );
    expect(status).toBe("Succeeded");
  }),
  { timeout: 1_200_000 },
);
