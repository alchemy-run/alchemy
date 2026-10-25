import { expect } from "bun:test";
import * as Azure from "@alchemy.run/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
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

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

/** The deployer's credentials, for out-of-band ARM and SAS calls. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

// One Flex Consumption app (billed per execution) and two Standard_LRS
// storage accounts: about a cent per run, about 3 minutes to deploy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

class NotOk extends Data.TaggedError("NotOk")<{ readonly status: number; readonly body: string }> {}

/**
 * Call the API and expect `expected`. Retries through the Flex Consumption
 * cold start and the role assignment propagating after the first deploy
 * (the API answers 502 with the Azure error tag until then).
 */
const call = (
  method: "GET" | "PUT" | "DELETE",
  path: string,
  expected: number,
  body?: { text: string; contentType: string },
) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const target = `${String(url).replace(/\/+$/, "")}${path}`;
    const request =
      method === "PUT"
        ? HttpClientRequest.put(target).pipe(
            HttpClientRequest.bodyText(body?.text ?? "", body?.contentType),
          )
        : method === "DELETE"
          ? HttpClientRequest.delete(target)
          : HttpClientRequest.get(target);
    const res = yield* HttpClient.execute(request);
    const text = yield* res.text;
    if (res.status !== expected) return yield* new NotOk({ status: res.status, body: text });
    return { text, contentType: res.headers["content-type"] };
  }).pipe(Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 36 }));

/** Where the example's resources are, from the stack outputs. */
const where = Effect.gen(function* () {
  const outputs = yield* stack;
  const { subscriptionId } = yield* Azure.AzureEnvironment.current.pipe(Effect.provide(azure));
  return { ...outputs, subscriptionId };
});

type Where = Effect.Success<typeof where>;

/** The files container's blob endpoint, signed with an account SAS the deployer lists through ARM. */
const sasUrl = (ids: Where) =>
  storage
    .ListStorageAccountAccountSAS({
      subscriptionId: ids.subscriptionId,
      resourceGroupName: ids.resourceGroup,
      accountName: ids.storageAccount,
      signedServices: "b",
      signedResourceTypes: "sco",
      signedPermission: "rwdl",
      signedProtocol: "https",
      signedExpiry: new Date(Date.now() + 3_600_000).toISOString(),
    })
    .pipe(
      Effect.map(
        ({ accountSasToken }) =>
          `https://${ids.storageAccount}.blob.core.windows.net/?${accountSasToken}`,
      ),
      Effect.provide(azure),
    );

const decode = (body: Uint8Array) => new TextDecoder().decode(body);

const found = Effect.as("found" as const);
const gone = () => Effect.succeed("gone" as const);

const siteStatus = (ids: Where) =>
  web
    .GetWebApp({
      subscriptionId: ids.subscriptionId,
      resourceGroupName: ids.resourceGroup,
      name: ids.functionAppName,
    })
    .pipe(found, Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], gone));

const accountStatus = (ids: Where, accountName: string) =>
  storage
    .GetStorageAccountProperties({
      subscriptionId: ids.subscriptionId,
      resourceGroupName: ids.resourceGroup,
      accountName,
    })
    .pipe(found, Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], gone));

/** Poll until a deleted resource reads as gone. */
const untilGone = <E, R>(status: Effect.Effect<"found" | "gone", E, R>) =>
  status.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (current) => current === "gone",
      times: 24,
    }),
    Effect.provide(azure),
  );

afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const ids = yield* where;
    yield* destroy(Stack);
    expect(yield* untilGone(siteStatus(ids))).toBe("gone");
    expect(yield* untilGone(accountStatus(ids, ids.storageAccount))).toBe("gone");
    expect(yield* untilGone(accountStatus(ids, ids.hostStorageAccount))).toBe("gone");
  }),
  { timeout: 600_000 },
);

test(
  "the function app runs as a managed identity with a data role on the container",
  Effect.gen(function* () {
    const ids = yield* where;
    const site = yield* web
      .GetWebApp({
        subscriptionId: ids.subscriptionId,
        resourceGroupName: ids.resourceGroup,
        name: ids.functionAppName,
      })
      .pipe(Effect.provide(azure));
    expect(site.kind).toContain("functionapp");
    expect(site.identity?.type).toBe("SystemAssigned");
    expect(site.properties?.functionAppConfig?.runtime?.name).toBe("node");

    const assignments = yield* authorization
      .ListRoleAssignmentForSubscription({
        subscriptionId: ids.subscriptionId,
        _filter: `principalId eq '${ids.principalId}'`,
      })
      .pipe(Effect.provide(azure));
    const grants = assignments.value.map(
      (a) =>
        `${a.properties?.roleDefinitionId?.split("/").pop()} ${a.properties?.scope?.toLowerCase()}`,
    );
    expect(grants).toContain(
      `${Azure.Authorization.BuiltInRole.StorageBlobDataContributor} ${ids.containerId.toLowerCase()}`,
    );
  }),
  { timeout: 120_000 },
);

test(
  "PUT stores the body as a blob and GET reads it back",
  Effect.gen(function* () {
    const ids = yield* where;
    const key = "notes/hello.txt";
    const content = `hello from azure functions ${crypto.randomUUID()}`;

    const put = yield* call("PUT", `/files/${key}`, 201, {
      text: content,
      contentType: "text/plain",
    });
    expect(JSON.parse(put.text).key).toBe(key);

    const get = yield* call("GET", `/files/${key}`, 200);
    expect(get.text).toBe(content);
    expect(get.contentType).toContain("text/plain");

    // Out of band: the blob is in the container, with the content type set.
    const url = yield* sasUrl(ids);
    const stored = yield* blob
      .DownloadBlob({ url, containerName: ids.container, blob: key })
      .pipe(Effect.provide(azure));
    expect(decode(stored.body)).toBe(content);
    expect(stored.contentType).toBe("text/plain");

    const list = yield* call("GET", "/files?prefix=notes/", 200);
    expect(JSON.parse(list.text)).toEqual({
      files: [{ key, size: new TextEncoder().encode(content).length, contentType: "text/plain" }],
    });
  }),
  { timeout: 300_000 },
);

test(
  "GET reads a blob uploaded out of band, DELETE removes it",
  Effect.gen(function* () {
    const ids = yield* where;
    const key = "uploads/report.json";
    const content = JSON.stringify({ id: crypto.randomUUID() });

    const url = yield* sasUrl(ids);
    yield* blob
      .UploadBlockBlob({
        url,
        containerName: ids.container,
        blob: key,
        body: new TextEncoder().encode(content),
        xMsBlobContentType: "application/json",
      })
      .pipe(Effect.provide(azure));

    const get = yield* call("GET", `/files/${key}`, 200);
    expect(get.text).toBe(content);
    expect(get.contentType).toContain("application/json");

    yield* call("DELETE", `/files/${key}`, 204);
    yield* call("GET", `/files/${key}`, 404);

    const after = yield* blob
      .DownloadBlob({ url, containerName: ids.container, blob: key })
      .pipe(
        Effect.as("found" as const),
        Effect.catchTag("BlobNotFound", gone),
        Effect.provide(azure),
      );
    expect(after).toBe("gone");
  }),
  { timeout: 300_000 },
);

test(
  "an unknown route answers 404",
  Effect.gen(function* () {
    const res = yield* call("GET", "/nope", 404);
    expect(res.text).toBe("Not Found");
  }),
  { timeout: 300_000 },
);
