import * as AWS from "@/AWS";
import { collectorExtensionLayerArn } from "@/AWS/Lambda/Collector.ts";
import * as Test from "@/Test/Alchemy";
import * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as S3 from "@distilled.cloud/aws/s3";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "alchemy-test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { fileURLToPath } from "node:url";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import {
  OtelExtensionFunction,
  OtelExtensionFunctionLive,
} from "./fixtures/otel-extension-handler.ts";
import {
  OtelExtensionReceiver,
  OtelExtensionReceiverLive,
} from "./fixtures/otel-extension-receiver.ts";

const architecture = "arm64" as const;
const remoteExportDelayMs = 4_000;
const collectionRetrySchedule = Schedule.max([
  Schedule.exponential(250),
  Schedule.recurs(8),
]);
const functionReadySchedule = Schedule.max([
  Schedule.fixed(500),
  Schedule.recurs(60),
]);

const collectorConfigPath = fileURLToPath(
  new URL("./fixtures/otel-collector-extension", import.meta.url),
);
const handlerPath = fileURLToPath(
  new URL("./fixtures/otel-extension-handler.ts", import.meta.url),
);

const { test } = Test.make({
  providers: AWS.providers(),
});

const readCollected = (bucketName: string) =>
  Effect.gen(function* () {
    const listed = yield* S3.listObjectsV2({
      Bucket: bucketName,
      Prefix: "otlp/",
    });
    return yield* Effect.all(
      (listed.Contents ?? []).flatMap((object) =>
        object.Key === undefined
          ? []
          : [
              S3.getObject({ Bucket: bucketName, Key: object.Key }).pipe(
                Effect.flatMap((result) =>
                  Stream.mkString(Stream.decodeText(result.Body!)),
                ),
              ),
            ],
      ),
      { concurrency: "unbounded" },
    ).pipe(Effect.map((items) => items.join("\n")));
  });

const expectCollected = (bucketName: string, marker: string) =>
  readCollected(bucketName).pipe(
    Effect.flatMap((collected) =>
      collected.includes(marker)
        ? Effect.void
        : Effect.fail(new Error(`OTLP receiver has not collected ${marker}`)),
    ),
    Effect.retry({
      schedule: collectionRetrySchedule,
    }),
  );

const expectCollectedWithDiagnostics = (
  bucketName: string,
  marker: string,
  functionName: string,
) =>
  expectCollected(bucketName, marker).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const result = yield* Logs.filterLogEvents({
          logGroupName: `/aws/lambda/${functionName}`,
          limit: 100,
        }).pipe(
          Effect.catch((logError) =>
            Effect.succeed({
              events: [
                {
                  message: `Unable to read Lambda logs: ${String(logError)}`,
                },
              ],
            }),
          ),
        );
        const messages = (result.events ?? [])
          .flatMap((event) => (event.message ? [event.message] : []))
          .join("\n");
        return yield* Effect.fail(
          new Error(`${error.message}\nLambda logs:\n${messages}`),
        );
      }),
    ),
  );

const getReadyFunction = (functionName: string) =>
  Lambda.getFunctionConfiguration({
    FunctionName: functionName,
  }).pipe(
    Effect.filterOrFail(
      (configuration) =>
        configuration.State === "Active" &&
        configuration.LastUpdateStatus === "Successful",
      (configuration) =>
        new Error(
          `Lambda is not ready: state=${configuration.State}, lastUpdateStatus=${configuration.LastUpdateStatus}`,
        ),
    ),
    Effect.retry({ schedule: functionReadySchedule }),
  );

describe("OpenTelemetry Collector Lambda extension", () => {
  it.effect(
    "bounds memory, keeps decouple last, and keeps the remote endpoint extension-owned",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* fs.readFileString(
          path.join(collectorConfigPath, "collector.yaml"),
        );
        expect(config).toContain("endpoint: 127.0.0.1:4318");
        expect(config).toContain(
          "endpoint: ${env:COLLECTOR_EXPORTER_OTLP_ENDPOINT}",
        );
        expect(config).toContain("memory_limiter:");
        expect(config).toContain(
          "processors: [memory_limiter, batch, decouple]",
        );
        expect(config).not.toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  test.provider.skipIf(!!process.env.FAST)(
    "exports remotely after the handler response through the real extension",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const client = yield* HttpClient.HttpClient;
        const receiverProgram = OtelExtensionReceiver.pipe(
          Effect.provide(OtelExtensionReceiverLive),
        );

        const receiver = yield* stack.deploy(receiverProgram);
        const receiverUrl = (receiver.functionUrl as string).replace(/\/$/, "");
        yield* expectUrlContains(receiverUrl, "otel-extension-receiver-ok", {
          timeout: "120 seconds",
        });
        const sinkBucketName = yield* client.get(receiverUrl).pipe(
          Effect.flatMap((response) => response.json),
          Effect.map((body) => (body as { bucketName: string }).bucketName),
        );
        const receiverProbe = `receiver-probe-${yield* Effect.sync(() =>
          crypto.randomUUID(),
        )}`;
        const receiverProbeResponse = yield* HttpClient.execute(
          HttpClientRequest.post(`${receiverUrl}/v1/traces`).pipe(
            HttpClientRequest.bodyText(receiverProbe),
          ),
        );
        expect(receiverProbeResponse.status).toBe(200);
        yield* expectCollected(sinkBucketName, receiverProbe);

        const { region } = yield* AWS.AWSEnvironment.current;
        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const receiver = yield* receiverProgram;
            // No layers, no OPENTELEMETRY_* env, no LayerVersion: the fixture
            // provides `AWS.Lambda.Collector` on its own Effect and the
            // binding channel carries all of it onto this Function.
            const fn = yield* OtelExtensionFunction.pipe(
              Effect.provide(
                OtelExtensionFunctionLive({
                  main: handlerPath,
                  architecture,
                  memorySize: 512,
                  timeout: Duration.seconds(15),
                  url: true,
                  collector: {
                    remoteOtlpEndpoint: receiver.functionUrl.as<string>(),
                    remoteExportDelayMs,
                  },
                }),
              ),
            );
            return { fn };
          }),
        );

        const cloudFunction = yield* getReadyFunction(deployed.fn.functionName);
        expect(cloudFunction.Architectures).toEqual([architecture]);
        // The managed extension is attached first, the generated config layer
        // second — the order `/opt` is populated in.
        const attachedLayers = cloudFunction.Layers?.map((layer) => layer.Arn);
        expect(attachedLayers?.[0]).toBe(
          collectorExtensionLayerArn({ region, architecture }),
        );
        expect(attachedLayers?.[1]).toMatch(
          /^arn:aws:lambda:[^:]+:\d{12}:layer:.*CollectorConfig.*:\d+$/i,
        );
        expect(attachedLayers).toHaveLength(2);
        const environment = cloudFunction.Environment?.Variables ?? {};
        const envValue = (key: string) => {
          const value = environment[key];
          return value === undefined || typeof value === "string"
            ? value
            : Redacted.value(value);
        };
        expect(envValue("OPENTELEMETRY_COLLECTOR_CONFIG_URI")).toBe(
          "/opt/collector.yaml",
        );
        expect(envValue("OTEL_EXPORTER_OTLP_ENDPOINT")).toBeUndefined();
        expect(envValue("ALCHEMY_OTEL_EXPORTERS")).toContain(
          "http://127.0.0.1:4318",
        );
        expect(
          envValue("COLLECTOR_EXPORTER_OTLP_ENDPOINT")?.replace(/\/$/, ""),
        ).toBe(receiverUrl);

        const fnUrl = (deployed.fn.functionUrl as string).replace(/\/$/, "");
        const invoke = Effect.fn(function* (marker: string) {
          const started = yield* Effect.sync(() => performance.now());
          const response = yield* client.get(
            `${fnUrl}/?marker=${encodeURIComponent(marker)}`,
          );
          const body = (yield* response.json) as {
            marker: string;
            sandboxId: string;
          };
          const elapsedMs = yield* Effect.sync(
            () => performance.now() - started,
          );
          return { body, elapsedMs, status: response.status };
        });

        const warmMarker = `warm-${yield* Effect.sync(() => crypto.randomUUID())}`;
        const warm = yield* invoke(warmMarker);
        expect(warm.status).toBe(200);
        expect(warm.body.marker).toBe(warmMarker);
        yield* expectCollectedWithDiagnostics(
          sinkBucketName,
          warmMarker,
          deployed.fn.functionName,
        );

        // The response is already back, but this environment does not become
        // eligible for another invocation until the extension finishes the
        // deliberately delayed remote export.
        yield* Effect.sleep(Duration.millis(remoteExportDelayMs + 1_000));

        const measuredMarker = `measured-${yield* Effect.sync(() =>
          crypto.randomUUID(),
        )}`;
        const measured = yield* invoke(measuredMarker);
        expect(measured.status).toBe(200);
        expect(measured.body.marker).toBe(measuredMarker);
        expect(measured.body.sandboxId).toBe(warm.body.sandboxId);
        expect(measured.elapsedMs).toBeLessThan(remoteExportDelayMs - 1_000);
        yield* Effect.logInfo(
          `Lambda response ${Math.round(measured.elapsedMs)}ms; remote receiver delay ${remoteExportDelayMs}ms`,
        );

        yield* expectCollected(sinkBucketName, measuredMarker);
        yield* expectCollected(sinkBucketName, "otel-lambda-extension-test");
        yield* expectCollected(sinkBucketName, "lambda.extension.child-span");
        yield* expectCollected(sinkBucketName, "lambda-extension-work-log");
      }).pipe(
        Effect.tap(() => stack.destroy()),
        Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
      ),
    { timeout: 220_000 },
  );
});
