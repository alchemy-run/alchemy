import * as AWS from "@/AWS";
import * as Axiom from "@/Axiom";
import * as Test from "@/Test/Alchemy";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { describe, expect, it } from "alchemy-test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { fileURLToPath } from "node:url";
import { expectAxiomContains } from "./fixtures/axiom-query.ts";
import {
  AxiomPlatformExtensionFunction,
  AxiomPlatformExtensionFunctionLive,
} from "./fixtures/axiom-platform-extension-handler.ts";

const axiomExtensionLayerVersion = 16;
const architecture = "arm64" as const;
const eventsDataset = process.env.AXIOM_TEST_EVENTS_DATASET ?? "";
const shouldRun =
  process.env.ALCHEMY_TEST_AXIOM_LAMBDA === "1" &&
  !!(process.env.AXIOM_TOKEN || process.env.AXIOM_API_KEY) &&
  eventsDataset.length > 0;

const axiomExtensionLayerArn = ({
  region,
  architecture,
}: {
  region: string;
  architecture: AWS.Lambda.FunctionArchitecture;
}) =>
  `arn:aws:lambda:${region}:694952825951:layer:axiom-extension-${architecture}:${axiomExtensionLayerVersion}`;

const handlerPath = fileURLToPath(
  new URL("./fixtures/axiom-platform-extension-handler.ts", import.meta.url),
);

const { test } = Test.make({
  providers: Layer.mergeAll(AWS.providers(), Axiom.providers()),
});

describe("Axiom Lambda platform extension", () => {
  it("derives the pinned public layer from Region and Lambda architecture", () => {
    expect(
      axiomExtensionLayerArn({
        region: "us-east-1",
        architecture: "x86_64",
      }),
    ).toBe(
      `arn:aws:lambda:us-east-1:694952825951:layer:axiom-extension-x86_64:${axiomExtensionLayerVersion}`,
    );
    expect(
      axiomExtensionLayerArn({
        region: "eu-west-1",
        architecture: "arm64",
      }),
    ).toBe(
      `arn:aws:lambda:eu-west-1:694952825951:layer:axiom-extension-arm64:${axiomExtensionLayerVersion}`,
    );
  });

  test.provider.skipIf(!shouldRun)(
    "exports function logs and Lambda platform events into the existing Axiom events dataset",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const marker = `alchemy-axiom-platform-${yield* Effect.sync(() =>
          crypto.randomUUID(),
        )}`;
        const { region } = yield* AWS.AWSEnvironment.current;

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const ingest = yield* Axiom.ApiToken("AxiomLambdaPlatformIngest", {
              name: "alchemy-lambda-platform-e2e",
              description:
                "Temporary ingest token for the Axiom Lambda extension test",
              datasetCapabilities: {
                [eventsDataset]: { ingest: ["create"] },
              },
            });
            const fn = yield* AxiomPlatformExtensionFunction.pipe(
              Effect.provide(
                AxiomPlatformExtensionFunctionLive({
                  main: handlerPath,
                  architecture,
                  memorySize: 256,
                  timeout: Duration.seconds(15),
                  functionUrl: true,
                  layers: [axiomExtensionLayerArn({ region, architecture })],
                  env: {
                    AXIOM_DATASET: eventsDataset,
                    AXIOM_FLUSH_TIMEOUT: "3s",
                    AXIOM_TOKEN: ingest.token,
                    PANIC_ON_API_ERR: "true",
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
        expect(cloudFunction.Layers?.map((layer) => layer.Arn)).toEqual([
          axiomExtensionLayerArn({ region, architecture }),
        ]);
        const environment = cloudFunction.Environment?.Variables ?? {};
        const envValue = (key: string) => {
          const value = environment[key];
          return value === undefined || typeof value === "string"
            ? value
            : Redacted.value(value);
        };
        expect(envValue("AXIOM_DATASET")).toBe(eventsDataset);
        expect(envValue("AXIOM_TOKEN")).toBeDefined();
        expect(envValue("AXIOM_TOKEN")).not.toBe(
          process.env.AXIOM_TOKEN ?? process.env.AXIOM_API_KEY,
        );
        expect(envValue("PANIC_ON_API_ERR")).toBe("true");

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
          dataset: eventsDataset,
          markers: [
            marker,
            "alchemy.axiom_lambda_extension.test",
            "platform.runtimeDone",
          ],
        });
      }).pipe(
        Effect.tap(() => stack.destroy()),
        Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
      ),
    // One Lambda deploy + `expectAxiomContains`'s bounded 36 x 5s ingest poll.
    { timeout: 300_000 },
  );
});
