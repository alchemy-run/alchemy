import * as GCP from "@/GCP";
import { zipFiles } from "@/Util/zip.ts";
import * as Test from "@/Test/Alchemy";
import * as cloudfunctions from "@distilled.cloud/gcp/cloudfunctions_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const LOCATION = "us-central1";

// Gen2 function create/update/delete is a multi-minute LRO. Set
// GCP_TEST_CLOUDFUNCTIONS=1 to run the lifecycle; default recapture
// keeps the list probe only.
const runLifecycle =
  hasGcpCreds && !!process.env.GCP_TEST_CLOUDFUNCTIONS && !process.env.FAST;

const waitUntilGone = (name: string) =>
  cloudfunctions.getProjectsLocationsFunctions({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const uploadSource = Effect.fn(function* () {
  const archive = yield* zipFiles([
    {
      path: "index.js",
      content: `exports.helloHttp = (req, res) => { res.status(200).send("ok"); };\n`,
    },
    {
      path: "package.json",
      content: JSON.stringify({
        name: "hello",
        private: true,
        main: "index.js",
      }),
    },
  ]);
  const uploaded =
    yield* cloudfunctions.generateUploadUrlProjectsLocationsFunctions({
      parent: `projects/${project}/locations/${LOCATION}`,
      body: { environment: "GEN_2" },
    });
  if (uploaded.uploadUrl === undefined) {
    return yield* Effect.die(
      new Error("generateUploadUrl did not return uploadUrl"),
    );
  }
  const client = yield* HttpClient.HttpClient;
  const bytes = yield* Effect.sync(() => new Uint8Array(archive));
  const response = yield* client.execute(
    HttpClientRequest.put(uploaded.uploadUrl).pipe(
      HttpClientRequest.bodyUint8Array(bytes, "application/zip"),
    ),
  );
  if (response.status < 200 || response.status >= 300) {
    return yield* Effect.die(
      new Error(`source upload failed with HTTP ${response.status}`),
    );
  }
  if (uploaded.storageSource === undefined) {
    return yield* Effect.die(
      new Error("generateUploadUrl did not return storageSource"),
    );
  }
  return uploaded.storageSource;
});

test.provider.skipIf(!hasGcpCreds)(
  "lists functions",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const page = yield* cloudfunctions.listProjectsLocationsFunctions({
        parent: `projects/${project}/locations/-`,
        pageSize: 10,
      });
      expect(Array.isArray(page.functions ?? [])).toEqual(true);
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 60_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a function",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const storageSource = yield* uploadSource();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudFunctions.Function("Hello", {
            location: LOCATION,
            description: "test http function",
            labels: { env: "test" },
            buildConfig: {
              runtime: "nodejs20",
              entryPoint: "helloHttp",
              source: { storageSource },
            },
            serviceConfig: {
              timeoutSeconds: 60,
              maxInstanceCount: 1,
            },
          });
        }),
      );

      expect(created.name).toContain("/functions/");
      expect(created.functionId).toEqual(expect.any(String));
      expect(created.location).toEqual(LOCATION);
      expect(created.environment).toEqual("GEN_2");
      expect(created.description).toEqual("test http function");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.runtime).toEqual("nodejs20");
      expect(created.entryPoint).toEqual("helloHttp");
      expect(created.state).toEqual("ACTIVE");

      const fetched = yield* cloudfunctions.getProjectsLocationsFunctions({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.description).toEqual("test http function");
      expect(fetched.buildConfig?.runtime).toEqual("nodejs20");
      expect(fetched.serviceConfig?.timeoutSeconds).toEqual(60);

      const downloaded =
        yield* cloudfunctions.generateDownloadUrlProjectsLocationsFunctions({
          name: created.name,
          body: {},
        });
      expect(downloaded.downloadUrl).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudFunctions.Function("Hello", {
            functionId: created.functionId,
            location: LOCATION,
            description: "prod http function",
            labels: { env: "prod", role: "http" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("prod http function");
      expect(updated.labels).toMatchObject({ env: "prod", role: "http" });

      const refetched = yield* cloudfunctions.getProjectsLocationsFunctions({
        name: created.name,
      });
      expect(refetched.description).toEqual("prod http function");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("http");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 240_000 },
);
