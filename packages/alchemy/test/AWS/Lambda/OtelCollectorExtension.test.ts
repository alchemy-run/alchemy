import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as S3 from "@distilled.cloud/aws/s3";
import { describe, expect, it } from "alchemy-test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { readFileSync } from "node:fs";
import * as pathe from "pathe";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import {
  OtelExtensionFunction,
  OtelExtensionFunctionLive,
} from "./fixtures/otel-extension-handler.ts";
import {
  OtelExtensionReceiver,
  OtelExtensionReceiverLive,
} from "./fixtures/otel-extension-receiver.ts";

const collectorRelease = "0_22_0";
const collectorLayerVersion = 1;
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

const collectorLayerArn = ({
  region,
  architecture,
}: {
  region: string;
  architecture: AWS.Lambda.FunctionArchitecture;
}) => {
  const layerArchitecture = architecture === "x86_64" ? "amd64" : architecture;
  return `arn:aws:lambda:${region}:184161586896:layer:opentelemetry-collector-${layerArchitecture}-${collectorRelease}:${collectorLayerVersion}`;
};

const collectorConfigPath = pathe.resolve(
  import.meta.dirname,
  "fixtures/otel-collector-extension",
);
const handlerPath = pathe.resolve(
  import.meta.dirname,
  "fixtures/otel-extension-handler.ts",
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
  it("maps Lambda architectures to the upstream managed layer names", () => {
    expect(
      collectorLayerArn({ region: "us-east-1", architecture: "x86_64" }),
    ).toContain(":layer:opentelemetry-collector-amd64-");
    expect(
      collectorLayerArn({ region: "eu-west-1", architecture: "arm64" }),
    ).toContain("arn:aws:lambda:eu-west-1:");
  });

  it("bounds memory, keeps decouple last, and keeps the remote endpoint extension-owned", () => {
    const config = readFileSync(
      pathe.join(collectorConfigPath, "collector.yaml"),
      "utf8",
    );
    expect(config).toContain("endpoint: 127.0.0.1:4318");
    expect(config).toContain(
      "endpoint: ${env:COLLECTOR_EXPORTER_OTLP_ENDPOINT}",
    );
    expect(config).toContain("memory_limiter:");
    expect(config).toContain("processors: [memory_limiter, batch, decouple]");
    expect(config).not.toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
  });

  test.provider(
    "exports remotely after the handler response through the real extension",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const receiverProgram = OtelExtensionReceiver.pipe(
          Effect.provide(OtelExtensionReceiverLive),
        );

        const receiver = yield* stack.deploy(receiverProgram);
        const receiverUrl = (receiver.functionUrl as string).replace(/\/$/, "");
        yield* expectUrlContains(receiverUrl, "otel-extension-receiver-ok", {
          timeout: "120 seconds",
        });
        const sinkBucketName = yield* Effect.tryPromise(() =>
          fetch(receiverUrl)
            .then((response) => response.json())
            .then((body) => (body as { bucketName: string }).bucketName),
        );
        const receiverProbe = `receiver-probe-${crypto.randomUUID()}`;
        const receiverProbeStatus = yield* Effect.tryPromise(() =>
          fetch(`${receiverUrl}/v1/traces`, {
            method: "POST",
            body: receiverProbe,
          }).then((response) => response.status),
        );
        expect(receiverProbeStatus).toBe(200);
        yield* expectCollected(sinkBucketName, receiverProbe);

        const { region } = yield* AWS.AWSEnvironment.current;
        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const receiver = yield* receiverProgram;
            const configLayer = yield* AWS.Lambda.LayerVersion(
              "OtelExtensionConfig",
              {
                path: collectorConfigPath,
                compatibleArchitectures: [architecture],
              },
            );
            const fn = yield* OtelExtensionFunction.pipe(
              Effect.provide(
                OtelExtensionFunctionLive({
                  main: handlerPath,
                  architecture,
                  memorySize: 512,
                  timeout: Duration.seconds(15),
                  url: true,
                  layers: [
                    collectorLayerArn({ region, architecture }),
                    configLayer,
                  ],
                  env: {
                    OPENTELEMETRY_COLLECTOR_CONFIG_URI: "/opt/collector.yaml",
                    OPENTELEMETRY_EXTENSION_LOG_LEVEL: "debug",
                    COLLECTOR_EXPORTER_OTLP_ENDPOINT: receiver.functionUrl,
                    OTEL_TEST_EXPORT_DELAY_MS: String(remoteExportDelayMs),
                  },
                }),
              ),
            );
            return { fn, configLayer };
          }),
        );

        expect(deployed.configLayer.compatibleArchitectures).toEqual([
          architecture,
        ]);
        const cloudFunction = yield* getReadyFunction(deployed.fn.functionName);
        expect(cloudFunction.Architectures).toEqual([architecture]);
        expect(cloudFunction.Layers?.map((layer) => layer.Arn)).toEqual([
          collectorLayerArn({ region, architecture }),
          deployed.configLayer.layerVersionArn,
        ]);
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
        const invoke = (marker: string) =>
          Effect.tryPromise(async () => {
            const started = performance.now();
            const response = await fetch(
              `${fnUrl}/?marker=${encodeURIComponent(marker)}`,
            );
            const body = (await response.json()) as {
              marker: string;
              sandboxId: string;
            };
            return {
              body,
              elapsedMs: performance.now() - started,
              status: response.status,
            };
          });

        const warmMarker = `warm-${crypto.randomUUID()}`;
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

        const measuredMarker = `measured-${crypto.randomUUID()}`;
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
