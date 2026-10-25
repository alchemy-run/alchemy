import { expect } from "bun:test";
import * as Azure from "@alchemy.run/azure";
import * as storage from "@distilled.cloud/azure/storage";
import * as blob from "@distilled.cloud/azure/storage-blob";
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
import { heartbeatKey, reportKey, type DailyReport, type Heartbeat } from "../src/resources.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

/** The deployer's credentials, for out-of-band ARM and blob reads. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

// One Flex Consumption app (billed per execution) and one Standard_LRS
// storage account: well under $0.01 per run, about 4 minutes.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

class NotOk extends Data.TaggedError("NotOk")<{ readonly status: number; readonly body: string }> {}
class Pending extends Data.TaggedError("Pending")<{ readonly key: string }> {}

/** `GET path` as JSON, through the cold start and the app's blob role propagating. */
const get = <T>(path: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(`${String(url).replace(/\/+$/, "")}${path}`);
    const body = yield* res.text;
    if (res.status !== 200) return yield* new NotOk({ status: res.status, body });
    return JSON.parse(body) as T;
  }).pipe(Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 48 }));

/** Where the example's resources are, from the stack outputs. */
const where = Effect.gen(function* () {
  const outputs = yield* stack;
  const { subscriptionId } = yield* Azure.AzureEnvironment.current.pipe(Effect.provide(azure));
  return { subscriptionId, ...outputs };
});

/**
 * Read a blob out of band through a one-hour service SAS (ARM
 * `listServiceSas`), so the check never waits on a data-plane role.
 */
const readBlob = <T>(key: string) =>
  Effect.gen(function* () {
    const ids = yield* where;
    const signedExpiry = yield* Effect.sync(() => new Date(Date.now() + 3_600_000).toISOString());
    const sas = yield* storage.ListStorageAccountServiceSAS({
      subscriptionId: ids.subscriptionId,
      resourceGroupName: ids.resourceGroup,
      accountName: ids.storageAccount,
      canonicalizedResource: `/blob/${ids.storageAccount}/${ids.container}`,
      signedResource: "c",
      signedPermission: "r",
      signedProtocol: "https",
      signedExpiry,
    });
    const downloaded = yield* blob.DownloadBlob({
      url: `https://${ids.storageAccount}.blob.core.windows.net?${sas.serviceSasToken}`,
      containerName: ids.container,
      blob: key,
    });
    return JSON.parse(new TextDecoder().decode(downloaded.body)) as T;
  }).pipe(Effect.provide(azure));

/** The first heartbeat written at or after `since` (the timer fires every minute). */
const heartbeatSince = (since: number) =>
  get<{ heartbeats: Heartbeat[] }>("/heartbeats?limit=1").pipe(
    Effect.map(({ heartbeats }) => heartbeats[0]),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (latest) => latest !== undefined && Date.parse(latest.at) >= since,
      times: 30,
    }),
  );

const functionAppStatus = Effect.gen(function* () {
  const ids = yield* where;
  return yield* web
    .GetWebApp({
      subscriptionId: ids.subscriptionId,
      resourceGroupName: ids.resourceGroup,
      name: ids.functionApp,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
        Effect.succeed("gone" as const),
      ),
      Effect.provide(azure),
    );
});

const storageAccountStatus = Effect.gen(function* () {
  const ids = yield* where;
  return yield* storage
    .GetStorageAccountProperties({
      subscriptionId: ids.subscriptionId,
      resourceGroupName: ids.resourceGroup,
      accountName: ids.storageAccount,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
        Effect.succeed("gone" as const),
      ),
      Effect.provide(azure),
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
    // Resolve the ids before the stack is gone.
    yield* where;
    yield* destroy(Stack);
    expect(yield* untilGone(functionAppStatus)).toBe("gone");
    expect(yield* untilGone(storageAccountStatus)).toBe("gone");
  }),
  { timeout: 900_000 },
);

test(
  "registers one timer function per schedule",
  Effect.gen(function* () {
    const ids = yield* where;
    const schedules = yield* web
      .ListWebAppFunctions({
        subscriptionId: ids.subscriptionId,
        resourceGroupName: ids.resourceGroup,
        name: ids.functionApp,
      })
      .pipe(
        Effect.map((page) =>
          Object.fromEntries(
            (page.value ?? []).map((fn) => {
              const config = fn.properties?.config as
                | { bindings?: { type?: string; schedule?: string }[] }
                | undefined;
              const timer = config?.bindings?.find((b) => b.type === "timerTrigger");
              return [(fn.name ?? "").split("/").pop() ?? "", timer?.schedule ?? null];
            }),
          ),
        ),
        // The host lists its functions once the first instance has started.
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (fns) => "timer-Heartbeat" in fns && "timer-DailyReport" in fns,
          times: 30,
        }),
        Effect.provide(azure),
      );
    expect(schedules["timer-Heartbeat"]).toBe("0 * * * * *");
    expect(schedules["timer-DailyReport"]).toBe("0 0 0 * * *");
  }),
  { timeout: 600_000 },
);

test(
  "the heartbeat schedule writes a blob every minute",
  Effect.gen(function* () {
    const since = Date.now() - 60_000;
    const latest = yield* heartbeatSince(since);
    expect(latest).not.toBeUndefined();
    expect(Date.parse(latest!.at)).toBeGreaterThanOrEqual(since);
    expect(latest!.isPastDue).toBe(false);

    // The route served a real blob.
    const stored = yield* readBlob<Heartbeat>(heartbeatKey(latest!.at));
    expect(stored).toEqual(latest!);
  }),
  { timeout: 600_000 },
);

test(
  "a forced run of the daily schedule writes a report",
  Effect.gen(function* () {
    const ids = yield* where;
    // At least one heartbeat for the report to count.
    yield* heartbeatSince(Date.now() - 120_000);

    // Run the timer now through the Functions host's admin API.
    const { masterKey } = yield* web
      .ListWebAppHostKeys({
        subscriptionId: ids.subscriptionId,
        resourceGroupName: ids.resourceGroup,
        name: ids.functionApp,
      })
      .pipe(Effect.provide(azure));
    expect(typeof masterKey).toBe("string");
    const before = Date.now();
    const res = yield* HttpClient.execute(
      HttpClientRequest.post(`https://${ids.hostName}/admin/functions/timer-DailyReport`).pipe(
        HttpClientRequest.setHeader("x-functions-key", masterKey!),
        HttpClientRequest.bodyJsonUnsafe({ input: "" }),
      ),
    ).pipe(
      Effect.flatMap((res) =>
        res.status === 202
          ? Effect.succeed(res.status)
          : Effect.flatMap(res.text, (body) =>
              Effect.fail(new NotOk({ status: res.status, body })),
            ),
      ),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
    );
    expect(res).toBe(202);

    const report = yield* get<{ reports: DailyReport[] }>("/reports?limit=1").pipe(
      Effect.flatMap(({ reports }) => {
        const latest = reports[0];
        return latest !== undefined && Date.parse(latest.at) >= before
          ? Effect.succeed(latest)
          : Effect.fail(new Pending({ key: "reports/" }));
      }),
      Effect.retry({
        while: (e) => e._tag === "Pending",
        schedule: Schedule.spaced("5 seconds"),
        times: 24,
      }),
    );
    expect(report.heartbeats).toBeGreaterThanOrEqual(1);
    expect(yield* readBlob<DailyReport>(reportKey(report.at))).toEqual(report);
  }),
  { timeout: 600_000 },
);
