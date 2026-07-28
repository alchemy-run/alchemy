import * as AWS from "@/AWS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { fileURLToPath } from "node:url";

const layerV1Path = fileURLToPath(
  new URL("./fixtures/layer-v1", import.meta.url),
);
const layerV2Path = fileURLToPath(
  new URL("./fixtures/layer-v2", import.meta.url),
);
const timeoutHandlerPath = fileURLToPath(
  new URL("./timeout-handler.ts", import.meta.url),
);

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "publish, republish, attach to a function, list, delete layer version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = ({
        path,
        description,
        withFunction = false,
        layered = true,
      }: {
        path: string;
        description?: string;
        withFunction?: boolean;
        layered?: boolean;
      }) =>
        Effect.gen(function* () {
          const layer = yield* AWS.Lambda.LayerVersion("Deps", {
            path,
            description,
            compatibleRuntimes: ["nodejs22.x"],
          });

          const fn = withFunction
            ? yield* AWS.Lambda.Function("LayeredFn", {
                main: timeoutHandlerPath,
                handler: "handler",
                isExternal: true,
                url: false,
                // Pass the resource itself — `layers` also accepts a raw ARN.
                layers: layered ? [layer] : [],
              })
            : undefined;

          return { layer, fn };
        });

      // --- create ---
      const created = yield* stack.deploy(program({ path: layerV1Path }));
      const v1 = created.layer;

      expect(v1.version).toBeGreaterThan(0);
      expect(v1.layerVersionArn).toBe(`${v1.layerArn}:${v1.version}`);
      expect(v1.compatibleRuntimes).toEqual(["nodejs22.x"]);

      const cloudV1 = yield* getLayerVersionOrUndefined(
        v1.layerName,
        v1.version,
      );
      expect(cloudV1).toBeDefined();
      expect(cloudV1!.LayerVersionArn).toBe(v1.layerVersionArn);
      expect(cloudV1!.Content?.CodeSha256).toBe(v1.codeSha256);

      // --- noop (identical content must not publish a new version) ---
      const unchanged = yield* stack.deploy(program({ path: layerV1Path }));
      expect(unchanged.layer.version).toBe(v1.version);
      expect(unchanged.layer.layerVersionArn).toBe(v1.layerVersionArn);

      // --- replace (changed content publishes a new version) ---
      const republished = yield* stack.deploy(program({ path: layerV2Path }));
      const v2 = republished.layer;

      expect(v2.layerName).toBe(v1.layerName);
      expect(v2.version).toBeGreaterThan(v1.version);
      expect(v2.layerVersionArn).not.toBe(v1.layerVersionArn);
      expect(v2.codeSha256).not.toBe(v1.codeSha256);

      // The replaced version is deleted as part of the replacement.
      expect(
        yield* getLayerVersionOrUndefined(v1.layerName, v1.version),
      ).toBeUndefined();

      // --- replace (changed description alone also republishes) ---
      const described = yield* stack.deploy(
        program({ path: layerV2Path, description: "with description" }),
      );
      expect(described.layer.version).toBeGreaterThan(v2.version);
      expect(described.layer.description).toBe("with description");

      const currentLayer = described.layer;

      // --- attach to a function ---
      const attached = yield* stack.deploy(
        program({
          path: layerV2Path,
          description: "with description",
          withFunction: true,
        }),
      );
      const functionName = attached.fn!.functionName;

      expect(
        (yield* getFunctionLayers(functionName)).map((layer) => layer.Arn),
      ).toEqual([currentLayer.layerVersionArn]);

      // --- detach ---
      yield* stack.deploy(
        program({
          path: layerV2Path,
          description: "with description",
          withFunction: true,
          layered: false,
        }),
      );
      expect(yield* getFunctionLayers(functionName)).toEqual([]);

      // --- list ---
      const provider = yield* Provider.findProvider(AWS.Lambda.LayerVersion);
      const versions = yield* provider.list();
      expect(
        versions.some(
          (version) => version.layerVersionArn === currentLayer.layerVersionArn,
        ),
      ).toBe(true);

      // --- delete ---
      yield* stack.destroy();

      expect(
        yield* getLayerVersionOrUndefined(
          currentLayer.layerName,
          currentLayer.version,
        ),
      ).toBeUndefined();
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { timeout: 360_000 },
);

const getLayerVersionOrUndefined = Effect.fn(function* (
  layerName: string,
  version: number,
) {
  return yield* Lambda.getLayerVersion({
    LayerName: layerName,
    VersionNumber: version,
  }).pipe(
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );
});

const getFunctionLayers = Effect.fn(function* (functionName: string) {
  const configuration = yield* Lambda.getFunctionConfiguration({
    FunctionName: functionName,
  });
  return configuration.Layers ?? [];
});
