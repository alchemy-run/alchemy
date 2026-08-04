import * as AWS from "@/AWS";
import { collectorExtensionLayerArn } from "@/AWS/Lambda/Collector.ts";
import * as Axiom from "@/Axiom";
import * as Test from "@/Test/Alchemy";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { describe, expect } from "alchemy-test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { fileURLToPath } from "node:url";
import {
  AxiomCollectorFunction,
  AxiomCollectorFunctionLive,
} from "./fixtures/axiom-otel-collector-handler.ts";
import { expectAxiomContains } from "./fixtures/axiom-query.ts";

const architecture = "arm64" as const;
const eventsDataset = process.env.AXIOM_TEST_EVENTS_DATASET ?? "";
const tracesDataset = process.env.AXIOM_TEST_TRACES_DATASET ?? "";
const shouldRun =
  process.env.ALCHEMY_TEST_AXIOM_LAMBDA === "1" &&
  !!(process.env.AXIOM_TOKEN || process.env.AXIOM_API_KEY) &&
  eventsDataset.length > 0 &&
  tracesDataset.length > 0;

const handlerPath = fileURLToPath(
  new URL("./fixtures/axiom-otel-collector-handler.ts", import.meta.url),
);

const { test } = Test.make({
  providers: Layer.mergeAll(AWS.providers(), Axiom.providers()),
});

describe("Effect OpenTelemetry Collector export to Axiom", () => {
  test.provider.skipIf(!shouldRun)(
    "exports Effect traces and logs through the real Collector extension into existing Axiom datasets",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const marker = `alchemy-lambda-otel-${yield* Effect.sync(() =>
          crypto.randomUUID(),
        )}`;
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
            // No layers, no LayerVersion, no OPENTELEMETRY_*/AXIOM_* env:
            // `Axiom.LambdaCollector` inside the fixture's Effect carries all
            // of it through the binding channel.
            const fn = yield* AxiomCollectorFunction.pipe(
              Effect.provide(
                AxiomCollectorFunctionLive({
                  main: handlerPath,
                  architecture,
                  memorySize: 512,
                  timeout: Duration.seconds(15),
                  url: true,
                  axiom: {
                    token: ingest,
                    traces: tracesDataset,
                    logs: eventsDataset,
                    endpoint: process.env.AXIOM_URL,
                  },
                }),
              ),
            );
            return { fn, ingest };
          }),
        );

        const cloudFunction = yield* Lambda.getFunctionConfiguration({
          FunctionName: deployed.fn.functionName,
        });
        expect(cloudFunction.Architectures).toEqual([architecture]);
        const attachedLayers = cloudFunction.Layers?.map((layer) => layer.Arn);
        expect(attachedLayers?.[0]).toBe(
          collectorExtensionLayerArn({ region, architecture }),
        );
        expect(attachedLayers?.[1]).toMatch(
          /^arn:aws:lambda:[^:]+:\d{12}:layer:.*AxiomCollectorConfig.*:\d+$/i,
        );
        expect(attachedLayers).toHaveLength(2);
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
        expect(envValue("AXIOM_LOGS_DATASET")).toBe(eventsDataset);
        expect(envValue("AXIOM_TRACES_DATASET")).toBe(tracesDataset);
        expect(envValue("AXIOM_INGEST_TOKEN")).toBeDefined();
        expect(envValue("AXIOM_INGEST_TOKEN")).not.toBe(
          process.env.AXIOM_TOKEN ?? process.env.AXIOM_API_KEY,
        );

        const functionUrl = (deployed.fn.functionUrl as string).replace(
          /\/$/,
          "",
        );
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.get(
          `${functionUrl}/?marker=${encodeURIComponent(marker)}`,
        );
        expect(response.status).toBe(200);
        expect(yield* response.text).toContain(marker);

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
    // One Lambda deploy + `expectAxiomContains`'s bounded 36 x 5s ingest poll.
    { timeout: 300_000 },
  );
});
