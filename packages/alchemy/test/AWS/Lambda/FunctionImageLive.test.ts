import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as ecr from "@distilled.cloud/aws/ecr";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

const fixture = `${import.meta.dirname}/fixtures/image-function`;
const functionName = "alchemy-test-lambda-container-image";

// Building two platform-specific Lambda base images, pushing them to ECR, and
// exercising two package-type replacements is intentionally outside the
// default fast sweep. Run explicitly with `AWS_TEST_SLOW=1`.
test.provider.skipIf(!process.env.AWS_TEST_SLOW || !!process.env.FAST)(
  "builds, invokes, updates, replaces, and destroys an image function",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* stack.destroy();

      const context = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-lambda-image-",
      });
      yield* fs.copy(fixture, context, { overwrite: true });

      const image = (architecture: AWS.Lambda.FunctionArchitecture) =>
        AWS.Lambda.Function("ContainerFunction", {
          functionName,
          image: { context, dockerfile: "Dockerfile" },
          imageConfig: {
            Command: ["index.handler"],
          },
          architecture,
          env: {
            IMAGE_FUNCTION_ENV: "bound",
          },
          url: false,
        });

      const first = yield* stack.deploy(image("x86_64"));
      expect(first.functionName).toBe(functionName);
      expect(first.code.image?.digest).toMatch(/^sha256:/);
      expect(first.code.image?.imageUri).toContain(`:${first.code.hash}`);
      expect(first.code.image!.resolvedImageUri).toBe(
        `${first.code.image!.repositoryUri}@${first.code.image!.digest}`,
      );
      yield* assertFunctionImage(first.functionName, "x86_64");
      expect(yield* invoke(first.functionName, "one")).toEqual({
        marker: "one",
        environment: "bound",
        event: { hello: "image" },
      });

      // Unchanged context: the engine and ECR tag are both a no-op.
      const unchanged = yield* stack.deploy(image("x86_64"));
      expect(unchanged.code.hash).toBe(first.code.hash);
      expect(unchanged.code.image?.digest).toBe(first.code.image?.digest);

      // A context change creates a new content-addressed tag and updates the
      // existing Lambda in place.
      yield* fs.writeFileString(path.join(context, "marker.txt"), "two\n");
      const updated = yield* stack.deploy(image("x86_64"));
      expect(updated.functionName).toBe(first.functionName);
      expect(updated.code.hash).not.toBe(first.code.hash);
      expect(updated.code.image?.digest).not.toBe(first.code.image?.digest);
      expect((yield* invoke(updated.functionName, "two")).marker).toBe("two");

      // Architecture maps to linux/arm64, participates in the image hash, and
      // updates the same function in place.
      const arm = yield* stack.deploy(image("arm64"));
      expect(arm.functionName).toBe(first.functionName);
      expect(arm.code.hash).not.toBe(updated.code.hash);
      yield* assertFunctionImage(arm.functionName, "arm64");
      expect((yield* invoke(arm.functionName, "two")).marker).toBe("two");

      const firstRepository = arm.code.image!.repositoryName;

      // Package type is immutable. A fixed function name therefore replaces
      // delete-first, allowing the same name to move Image -> Zip.
      const zip = yield* stack.deploy(
        AWS.Lambda.Function("ContainerFunction", {
          functionName,
          main: `${import.meta.dirname}/timeout-handler.ts`,
          handler: "handler",
          isExternal: true,
          url: false,
        }),
      );
      expect(zip.functionName).toBe(functionName);
      yield* assertFunctionPackageType(zip.functionName, "Zip");
      yield* assertRepositoryDeleted(firstRepository);

      // And Zip -> Image uses the same replacement behavior.
      const replaced = yield* stack.deploy(image("x86_64"));
      expect(replaced.functionName).toBe(functionName);
      yield* assertFunctionImage(replaced.functionName, "x86_64");
      expect((yield* invoke(replaced.functionName, "two")).marker).toBe("two");

      const finalRepository = replaced.code.image!.repositoryName;
      yield* stack.destroy();
      yield* assertFunctionDeleted(functionName);
      yield* assertRepositoryDeleted(finalRepository);
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { timeout: 120_000 },
);

const invoke = Effect.fn(function* (
  deployedFunctionName: string,
  expectedMarker: string,
) {
  return yield* Lambda.invoke({
    FunctionName: deployedFunctionName,
    Payload: JSON.stringify({ hello: "image" }),
  }).pipe(
    Effect.flatMap((response) =>
      Effect.gen(function* () {
        if (response.FunctionError) {
          return yield* Effect.fail(
            new Error(`Lambda invocation failed: ${response.FunctionError}`),
          );
        }
        const payload = response.Payload
          ? yield* response.Payload.pipe(Stream.decodeText(), Stream.mkString)
          : "";
        return JSON.parse(payload) as {
          marker: string;
          environment: string;
          event: { hello: string };
        };
      }),
    ),
    Effect.filterOrFail(
      (response) => response.marker === expectedMarker,
      () => new Error(`Lambda is not serving marker ${expectedMarker} yet`),
    ),
    Effect.retry({
      schedule: Schedule.spaced("2 seconds"),
      times: 30,
    }),
  );
});

const assertFunctionImage = Effect.fn(function* (
  deployedFunctionName: string,
  architecture: AWS.Lambda.FunctionArchitecture,
) {
  yield* Lambda.getFunction({ FunctionName: deployedFunctionName }).pipe(
    Effect.filterOrFail(
      (response) =>
        response.Configuration?.PackageType === "Image" &&
        response.Configuration.Architectures?.[0] === architecture &&
        response.Code?.ResolvedImageUri?.includes("@sha256:") === true,
      () => new Error("Lambda image configuration has not propagated yet"),
    ),
    Effect.retry({
      schedule: Schedule.spaced("2 seconds"),
      times: 30,
    }),
  );
});

const assertFunctionPackageType = Effect.fn(function* (
  deployedFunctionName: string,
  packageType: Lambda.PackageType,
) {
  yield* Lambda.getFunction({ FunctionName: deployedFunctionName }).pipe(
    Effect.filterOrFail(
      (response) => response.Configuration?.PackageType === packageType,
      () => new Error(`Lambda package type is not ${packageType} yet`),
    ),
    Effect.retry({
      schedule: Schedule.spaced("2 seconds"),
      times: 30,
    }),
  );
});

const assertFunctionDeleted = Effect.fn(function* (
  deployedFunctionName: string,
) {
  yield* Lambda.getFunction({ FunctionName: deployedFunctionName }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error(`Function ${deployedFunctionName} still exists`)),
    ),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );
});

const assertRepositoryDeleted = Effect.fn(function* (repositoryName: string) {
  yield* ecr.describeRepositories({ repositoryNames: [repositoryName] }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error(`Repository ${repositoryName} still exists`)),
    ),
    Effect.catchTag("RepositoryNotFoundException", () => Effect.void),
    Effect.retry({
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );
});
