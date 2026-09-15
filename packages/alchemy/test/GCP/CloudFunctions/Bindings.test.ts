import { Action } from "@/Action";
import * as GCP from "@/GCP";
import { zipFiles } from "@/Util/zip.ts";
import * as Test from "@/Test/Alchemy";
import * as cloudfunctions from "@distilled.cloud/gcp/cloudfunctions_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
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

const runLifecycle =
  hasGcpCreds && !!process.env.GCP_TEST_CLOUDFUNCTIONS && !process.env.FAST;

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
  if (
    uploaded.uploadUrl === undefined ||
    uploaded.storageSource === undefined
  ) {
    return yield* Effect.die(new Error("generateUploadUrl incomplete"));
  }
  const client = yield* HttpClient.HttpClient;
  const bytes = yield* Effect.sync(() => new Uint8Array(archive));
  yield* client.execute(
    HttpClientRequest.put(uploaded.uploadUrl).pipe(
      HttpClientRequest.bodyUint8Array(bytes, "application/zip"),
    ),
  );
  return uploaded.storageSource;
});

test.provider.skipIf(!runLifecycle)(
  "GetFunction and GenerateDownloadUrl invoke HTTP bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const storageSource = yield* uploadSource();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const fn = yield* GCP.CloudFunctions.Function("Hello", {
            location: LOCATION,
            buildConfig: {
              runtime: "nodejs20",
              entryPoint: "helloHttp",
              source: { storageSource },
            },
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* fn.name;
              const getFunction = yield* GCP.CloudFunctions.GetFunction(fn);
              const download =
                yield* GCP.CloudFunctions.GenerateDownloadUrl(fn);
              return Effect.fn(function* () {
                const live = yield* getFunction();
                const { downloadUrl } = yield* download();
                return { live, downloadUrl };
              });
            }),
          );
          return { fn, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.live.name).toEqual(out.fn.name);
      expect(out.probe.downloadUrl).toEqual(expect.any(String));

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
