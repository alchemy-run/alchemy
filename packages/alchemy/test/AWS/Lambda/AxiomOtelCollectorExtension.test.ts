import * as AWS from "@/AWS";
import * as Axiom from "@/Axiom";
import * as Test from "@/Test/Alchemy";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { describe, expect, it } from "alchemy-test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as pathe from "pathe";
import { expectAxiomContains } from "./fixtures/axiom-query.ts";
import {
  OtelExtensionFunction,
  OtelExtensionFunctionLive,
} from "./fixtures/otel-extension-handler.ts";

const collectorRelease = "0_22_0";
const collectorLayerVersion = 1;
const architecture = "arm64" as const;
const eventsDataset = process.env.AXIOM_TEST_EVENTS_DATASET ?? "";
const tracesDataset = process.env.AXIOM_TEST_TRACES_DATASET ?? "";
const shouldRun =
  process.env.ALCHEMY_TEST_AXIOM_LAMBDA === "1" &&
  !!(process.env.AXIOM_TOKEN || process.env.AXIOM_API_KEY) &&
  eventsDataset.length > 0 &&
  tracesDataset.length > 0;

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
  "fixtures/axiom-otel-collector",
);
const handlerPath = pathe.resolve(
  import.meta.dirname,
  "fixtures/otel-extension-handler.ts",
);

const { test } = Test.make({
  providers: Layer.mergeAll(AWS.providers(), Axiom.providers()),
});

describe("Effect OpenTelemetry Collector export to Axiom", () => {
  it("uses separate extension-owned exporters for traces and logs", () => {
    const config = Bun.file(
      pathe.join(collectorConfigPath, "collector.yaml"),
    ).text();
    return config.then((text) => {
      expect(text).toContain("endpoint: 127.0.0.1:4318");
      expect(text).toContain("otlphttp/axiom-traces:");
      expect(text).toContain("otlphttp/axiom-logs:");
      expect(text).toContain(
        "processors: [memory_limiter, resource, batch, decouple]",
      );
      expect(text).not.toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
    });
  });

  test.provider.skipIf(!shouldRun)(
    "exports Effect traces and logs through the real Collector extension into existing Axiom datasets",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const marker = `alchemy-lambda-otel-${crypto.randomUUID()}`;
        const { region } = yield* AWS.AWSEnvironment.current;

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const ingest = yield* Axiom.ApiToken("AxiomLambdaOtelIngest", {
              name: "alchemy-lambda-otel-e2e",
              description:
                "Temporary ingest token for the Alchemy Lambda OTel test",
              datasetCapabilities: {
                [eventsDataset]: { ingest: ["create"] },
                [tracesDataset]: { ingest: ["create"] },
              },
            });
            const configLayer = yield* AWS.Lambda.LayerVersion(
              "AxiomOtelCollectorConfig",
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
                    AXIOM_EVENTS_DATASET: eventsDataset,
                    AXIOM_INGEST_TOKEN: ingest.token,
                    AXIOM_OTLP_ENDPOINT:
                      process.env.AXIOM_URL ?? "https://api.axiom.co",
                    AXIOM_TRACES_DATASET: tracesDataset,
                    OPENTELEMETRY_COLLECTOR_CONFIG_URI: "/opt/collector.yaml",
                  },
                }),
              ),
            );
            return { configLayer, fn, ingest };
          }),
        );

        const cloudFunction = yield* Lambda.getFunctionConfiguration({
          FunctionName: deployed.fn.functionName,
        });
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
        expect(envValue("ALCHEMY_OTEL_EXPORTERS")).toContain(
          "http://127.0.0.1:4318",
        );
        expect(envValue("OTEL_EXPORTER_OTLP_ENDPOINT")).toBeUndefined();
        expect(envValue("AXIOM_EVENTS_DATASET")).toBe(eventsDataset);
        expect(envValue("AXIOM_TRACES_DATASET")).toBe(tracesDataset);
        expect(envValue("AXIOM_INGEST_TOKEN")).toBeDefined();
        expect(envValue("AXIOM_INGEST_TOKEN")).not.toBe(
          process.env.AXIOM_TOKEN ?? process.env.AXIOM_API_KEY,
        );

        const functionUrl = (deployed.fn.functionUrl as string).replace(
          /\/$/,
          "",
        );
        const response = yield* Effect.tryPromise(() =>
          fetch(`${functionUrl}/?marker=${encodeURIComponent(marker)}`),
        );
        expect(response.status).toBe(200);
        expect(yield* Effect.tryPromise(() => response.text())).toContain(
          marker,
        );

        yield* expectAxiomContains({
          dataset: tracesDataset,
          markers: [
            marker,
            "lambda.extension.child-span",
            "otel-lambda-extension-test",
          ],
        });
        yield* expectAxiomContains({
          dataset: eventsDataset,
          markers: [marker, "lambda-extension-work-log"],
        });
      }).pipe(
        Effect.tap(() => stack.destroy()),
        Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
      ),
    { timeout: 600_000 },
  );
});
