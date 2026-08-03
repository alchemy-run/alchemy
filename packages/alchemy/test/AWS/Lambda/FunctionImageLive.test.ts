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
const coreFunctionName = "alchemy-test-lambda-container-image";
const armFunctionName = "alchemy-test-lambda-container-image-arm64";
const zipFunctionName = "alchemy-test-lambda-container-image-zip";
const skipLive = !process.env.AWS_TEST_SLOW || !!process.env.FAST;

const imageFunction = (
  context: string,
  functionName: string,
  architecture: AWS.Lambda.FunctionArchitecture,
) =>
  AWS.Lambda.Function("ContainerFunction", {
    functionName,
    image: { context, dockerfile: "Dockerfile" },
    architecture,
    env: {
      IMAGE_FUNCTION_ENV: "bound",
    },
    url: false,
  });

const zipFunction = (functionName: string) =>
  AWS.Lambda.Function("ContainerFunction", {
    functionName,
    main: `${import.meta.dirname}/timeout-handler.ts`,
    handler: "handler",
    isExternal: true,
    url: false,
  });

// Docker builds, ECR pushes, Lambda propagation, and the provider's bounded
// CloudWatch Logs cleanup make these unsuitable for the default fast sweep.
// Each test is kept within one deletion window and runs only when explicitly
// requested with `AWS_TEST_SLOW=1`.
test.provider.skipIf(skipLive)(
  "builds, invokes, updates, and destroys an image function",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* stack.destroy();

      const context = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-lambda-image-",
      });
      yield* fs.copy(fixture, context, { overwrite: true });

      const first = yield* stack.deploy(
        imageFunction(context, coreFunctionName, "x86_64"),
      );
      expect(first.functionName).toBe(coreFunctionName);
      expect(first.code.image?.digest).toMatch(/^sha256:/);
      expect(first.code.image?.imageUri).toContain(`:${first.code.hash}`);
      expect(first.code.image!.resolvedImageUri).toBe(
        `${first.code.image!.repositoryUri}@${first.code.image!.digest}`,
      );
      yield* assertRepositoryImmutable(first.code.image!.repositoryName);
      yield* assertFunctionImage(first.functionName, "x86_64");
      expect(yield* invoke(first.functionName, "one")).toEqual({
        marker: "one",
        environment: "bound",
        event: { hello: "image" },
      });

      // Unchanged context: the engine and ECR tag are both a no-op.
      const unchanged = yield* stack.deploy(
        imageFunction(context, coreFunctionName, "x86_64"),
      );
      expect(unchanged.code.hash).toBe(first.code.hash);
      expect(unchanged.code.image?.digest).toBe(first.code.image?.digest);

      // Repository drift alone must plan an update so reconcile can restore
      // the content-addressing and Lambda pull contracts.
      yield* ecr.putImageTagMutability({
        repositoryName: unchanged.code.image!.repositoryName,
        imageTagMutability: "MUTABLE",
      });
      yield* ecr.deleteRepositoryPolicy({
        repositoryName: unchanged.code.image!.repositoryName,
      });
      const repositoryDriftPlan = yield* stack.plan(
        imageFunction(context, coreFunctionName, "x86_64"),
      );
      expect(repositoryDriftPlan.resources["ContainerFunction"]).toMatchObject({
        action: "update",
      });
      const repaired = yield* stack.deploy(
        imageFunction(context, coreFunctionName, "x86_64"),
      );
      yield* assertRepositoryImmutable(repaired.code.image!.repositoryName);
      yield* assertRepositoryPolicy(repaired.code.image!.repositoryName);

      // A context change creates a new content-addressed tag and updates the
      // existing Lambda in place.
      yield* fs.writeFileString(path.join(context, "marker.txt"), "two\n");
      const updated = yield* stack.deploy(
        imageFunction(context, coreFunctionName, "x86_64"),
      );
      expect(updated.functionName).toBe(first.functionName);
      expect(updated.code.hash).not.toBe(first.code.hash);
      expect(updated.code.image?.digest).not.toBe(first.code.image?.digest);
      yield* assertRepositoryImmutable(updated.code.image!.repositoryName);
      expect((yield* invoke(updated.functionName, "two")).marker).toBe("two");

      // Architecture changes update the image function. The separate arm64
      // smoke test below performs the platform-specific build and invocation.
      const armPlan = yield* stack.plan(
        imageFunction(context, coreFunctionName, "arm64"),
      );
      expect(armPlan.resources["ContainerFunction"]).toMatchObject({
        action: "update",
      });

      // Package type is immutable. A fixed function name must be deleted
      // before the Zip replacement can reuse it.
      const zipPlan = yield* stack.plan(zipFunction(coreFunctionName));
      expect(zipPlan.resources["ContainerFunction"]).toMatchObject({
        action: "replace",
        deleteFirst: true,
      });

      const repositoryName = updated.code.image!.repositoryName;
      yield* stack.destroy();
      yield* assertFunctionDeleted(coreFunctionName);
      yield* assertRepositoryDeleted(repositoryName);
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { timeout: 120_000 },
);

test.provider.skipIf(skipLive)(
  "builds and invokes an arm64 image function",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* stack.destroy();

      const context = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-lambda-image-arm64-",
      });
      yield* fs.copy(fixture, context, { overwrite: true });

      const deployed = yield* stack.deploy(
        imageFunction(context, armFunctionName, "arm64"),
      );
      expect(deployed.functionName).toBe(armFunctionName);
      expect(deployed.code.image?.digest).toMatch(/^sha256:/);
      yield* assertRepositoryImmutable(deployed.code.image!.repositoryName);
      yield* assertFunctionImage(deployed.functionName, "arm64");
      expect(yield* invoke(deployed.functionName, "one")).toEqual({
        marker: "one",
        environment: "bound",
        event: { hello: "image" },
      });

      const repositoryName = deployed.code.image!.repositoryName;
      yield* stack.destroy();
      yield* assertFunctionDeleted(armFunctionName);
      yield* assertRepositoryDeleted(repositoryName);
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { timeout: 120_000 },
);

test.provider.skipIf(skipLive)(
  "plans a Zip function replacement with an image function",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* stack.destroy();

      const context = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-lambda-image-replacement-",
      });
      yield* fs.copy(fixture, context, { overwrite: true });

      const deployed = yield* stack.deploy(zipFunction(zipFunctionName));
      expect(deployed.functionName).toBe(zipFunctionName);
      yield* assertFunctionPackageType(deployed.functionName, "Zip");

      const renamedPlan = yield* stack.plan(
        zipFunction(`${zipFunctionName}-renamed`),
      );
      expect(renamedPlan.resources["ContainerFunction"]).toMatchObject({
        action: "replace",
        deleteFirst: false,
      });

      const imagePlan = yield* stack.plan(
        imageFunction(context, zipFunctionName, "x86_64"),
      );
      expect(imagePlan.resources["ContainerFunction"]).toMatchObject({
        action: "replace",
        deleteFirst: true,
      });

      yield* stack.destroy();
      yield* assertFunctionDeleted(zipFunctionName);
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
      times: 10,
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
        response.Configuration?.State === "Active" &&
        response.Configuration.LastUpdateStatus === "Successful" &&
        response.Configuration?.PackageType === "Image" &&
        response.Configuration.Architectures?.[0] === architecture &&
        response.Code?.ResolvedImageUri?.includes("@sha256:") === true,
      () => new Error("Lambda image configuration has not propagated yet"),
    ),
    Effect.retry({
      schedule: Schedule.spaced("2 seconds"),
      times: 10,
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
      times: 10,
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

const assertRepositoryImmutable = Effect.fn(function* (repositoryName: string) {
  yield* ecr.describeRepositories({ repositoryNames: [repositoryName] }).pipe(
    Effect.filterOrFail(
      (response) =>
        response.repositories?.[0]?.imageTagMutability === "IMMUTABLE",
      () => new Error(`Repository ${repositoryName} is not immutable`),
    ),
  );
});

const assertRepositoryPolicy = Effect.fn(function* (repositoryName: string) {
  yield* ecr.getRepositoryPolicy({ repositoryName }).pipe(
    Effect.filterOrFail(
      (response) =>
        response.policyText?.includes("LambdaECRImageRetrievalPolicy") === true,
      () => new Error(`Repository ${repositoryName} has no Lambda pull policy`),
    ),
  );
});
