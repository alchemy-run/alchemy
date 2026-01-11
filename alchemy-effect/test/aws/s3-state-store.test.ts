import * as AWS from "@/aws";
import * as S3StateStore from "@/aws/s3-state-store";
import { S3Client } from "@/aws/s3";
import * as State from "@/state";
import { expect, it, describe } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { NodeContext } from "@effect/platform-node";
import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import * as Region from "@/aws/region";
import * as Credentials from "@/aws/credentials";

/**
 * Integration tests for S3StateStore.
 *
 * Prerequisites:
 * - An S3 bucket must exist and be accessible
 * - AWS credentials must be configured (via env vars, profile, or IAM role)
 * - Set TEST_S3_BUCKET environment variable to the bucket name
 *
 * To run:
 *   TEST_S3_BUCKET=my-test-bucket bun test s3-state-store
 */

const TEST_BUCKET = process.env.TEST_S3_BUCKET;

// Skip tests if no bucket is configured
const testOrSkip = TEST_BUCKET ? it : it.skip;

describe("S3StateStore", () => {
  const testPrefix = `test-${Date.now()}`;

  // Create layers for testing
  const s3Layers = Layer.provideMerge(
    AWS.clients(),
    Layer.merge(Region.fromEnv(), Credentials.fromChain()),
  );

  const stateLayer = S3StateStore.s3({
    bucketName: TEST_BUCKET!,
    prefix: testPrefix,
  }).pipe(Layer.provide(s3Layers));

  const testLayers = Layer.mergeAll(
    stateLayer,
    s3Layers,
    NodeContext.layer,
    FetchHttpClient.layer,
  );

  testOrSkip(
    "set and get resource state",
    () =>
      Effect.gen(function* () {
        const state = yield* State.State;

        const testState: State.CreatedResourceState = {
          resourceType: "Test::Resource",
          logicalId: "TestResource",
          instanceId: "inst-123",
          providerVersion: 1,
          status: "created",
          downstream: [],
          props: { name: "test" },
          attr: { id: "res-456" },
        };

        // Set state
        yield* state.set({
          stack: "test-stack",
          stage: "test-stage",
          resourceId: "TestResource",
          value: testState,
        });

        // Get state
        const retrieved = yield* state.get({
          stack: "test-stack",
          stage: "test-stage",
          resourceId: "TestResource",
        });

        expect(retrieved).toBeDefined();
        expect(retrieved?.logicalId).toEqual("TestResource");
        expect(retrieved?.status).toEqual("created");
        expect(retrieved?.props).toEqual({ name: "test" });
        expect(retrieved?.attr).toEqual({ id: "res-456" });

        // Clean up
        yield* state.delete({
          stack: "test-stack",
          stage: "test-stage",
          resourceId: "TestResource",
        });
      }).pipe(Effect.provide(testLayers)),
    { timeout: 30000 },
  );

  testOrSkip(
    "get returns undefined for non-existent resource",
    () =>
      Effect.gen(function* () {
        const state = yield* State.State;

        const result = yield* state.get({
          stack: "non-existent-stack",
          stage: "non-existent-stage",
          resourceId: "NonExistentResource",
        });

        expect(result).toBeUndefined();
      }).pipe(Effect.provide(testLayers)),
    { timeout: 30000 },
  );

  testOrSkip(
    "list resources in a stage",
    () =>
      Effect.gen(function* () {
        const state = yield* State.State;

        // Create some test resources
        const testState1: State.CreatedResourceState = {
          resourceType: "Test::Resource",
          logicalId: "Resource1",
          instanceId: "inst-1",
          providerVersion: 1,
          status: "created",
          downstream: [],
          props: {},
          attr: {},
        };

        const testState2: State.CreatedResourceState = {
          resourceType: "Test::Resource",
          logicalId: "Resource2",
          instanceId: "inst-2",
          providerVersion: 1,
          status: "created",
          downstream: [],
          props: {},
          attr: {},
        };

        yield* state.set({
          stack: "list-test-stack",
          stage: "list-test-stage",
          resourceId: "Resource1",
          value: testState1,
        });

        yield* state.set({
          stack: "list-test-stack",
          stage: "list-test-stage",
          resourceId: "Resource2",
          value: testState2,
        });

        // List resources
        const resources = yield* state.list({
          stack: "list-test-stack",
          stage: "list-test-stage",
        });

        expect(resources).toContain("Resource1");
        expect(resources).toContain("Resource2");

        // Clean up
        yield* state.delete({
          stack: "list-test-stack",
          stage: "list-test-stage",
          resourceId: "Resource1",
        });
        yield* state.delete({
          stack: "list-test-stack",
          stage: "list-test-stage",
          resourceId: "Resource2",
        });
      }).pipe(Effect.provide(testLayers)),
    { timeout: 30000 },
  );

  testOrSkip(
    "delete resource state",
    () =>
      Effect.gen(function* () {
        const state = yield* State.State;

        const testState: State.CreatedResourceState = {
          resourceType: "Test::Resource",
          logicalId: "DeleteTest",
          instanceId: "inst-del",
          providerVersion: 1,
          status: "created",
          downstream: [],
          props: {},
          attr: {},
        };

        // Set state
        yield* state.set({
          stack: "delete-test-stack",
          stage: "delete-test-stage",
          resourceId: "DeleteTest",
          value: testState,
        });

        // Verify it exists
        const before = yield* state.get({
          stack: "delete-test-stack",
          stage: "delete-test-stage",
          resourceId: "DeleteTest",
        });
        expect(before).toBeDefined();

        // Delete it
        yield* state.delete({
          stack: "delete-test-stack",
          stage: "delete-test-stage",
          resourceId: "DeleteTest",
        });

        // Verify it's gone
        const after = yield* state.get({
          stack: "delete-test-stack",
          stage: "delete-test-stage",
          resourceId: "DeleteTest",
        });
        expect(after).toBeUndefined();
      }).pipe(Effect.provide(testLayers)),
    { timeout: 30000 },
  );

  testOrSkip(
    "delete non-existent resource does not error",
    () =>
      Effect.gen(function* () {
        const state = yield* State.State;

        // Should not throw
        yield* state.delete({
          stack: "non-existent-stack",
          stage: "non-existent-stage",
          resourceId: "NonExistent",
        });
      }).pipe(Effect.provide(testLayers)),
    { timeout: 30000 },
  );

  testOrSkip(
    "listStacks returns stacks",
    () =>
      Effect.gen(function* () {
        const state = yield* State.State;

        // Create a resource to ensure the stack exists
        const testState: State.CreatedResourceState = {
          resourceType: "Test::Resource",
          logicalId: "StackTest",
          instanceId: "inst-stack",
          providerVersion: 1,
          status: "created",
          downstream: [],
          props: {},
          attr: {},
        };

        yield* state.set({
          stack: "stack-test-unique",
          stage: "test-stage",
          resourceId: "StackTest",
          value: testState,
        });

        // List stacks
        const stacks = yield* state.listStacks();
        expect(stacks).toContain("stack-test-unique");

        // Clean up
        yield* state.delete({
          stack: "stack-test-unique",
          stage: "test-stage",
          resourceId: "StackTest",
        });
      }).pipe(Effect.provide(testLayers)),
    { timeout: 30000 },
  );

  testOrSkip(
    "listStages returns stages for a stack",
    () =>
      Effect.gen(function* () {
        const state = yield* State.State;

        // Create resources in different stages
        const testState: State.CreatedResourceState = {
          resourceType: "Test::Resource",
          logicalId: "StageTest",
          instanceId: "inst-stage",
          providerVersion: 1,
          status: "created",
          downstream: [],
          props: {},
          attr: {},
        };

        yield* state.set({
          stack: "stage-test-stack",
          stage: "dev",
          resourceId: "StageTest",
          value: testState,
        });

        yield* state.set({
          stack: "stage-test-stack",
          stage: "prod",
          resourceId: "StageTest",
          value: testState,
        });

        // List stages
        const stages = yield* state.listStages("stage-test-stack");
        expect(stages).toContain("dev");
        expect(stages).toContain("prod");

        // Clean up
        yield* state.delete({
          stack: "stage-test-stack",
          stage: "dev",
          resourceId: "StageTest",
        });
        yield* state.delete({
          stack: "stage-test-stack",
          stage: "prod",
          resourceId: "StageTest",
        });
      }).pipe(Effect.provide(testLayers)),
    { timeout: 30000 },
  );

  testOrSkip(
    "getReplacedResources returns only replaced resources",
    () =>
      Effect.gen(function* () {
        const state = yield* State.State;

        const createdState: State.CreatedResourceState = {
          resourceType: "Test::Resource",
          logicalId: "Created",
          instanceId: "inst-created",
          providerVersion: 1,
          status: "created",
          downstream: [],
          props: {},
          attr: {},
        };

        const replacedState: State.ReplacedResourceState = {
          resourceType: "Test::Resource",
          logicalId: "Replaced",
          instanceId: "inst-replaced",
          providerVersion: 1,
          status: "replaced",
          downstream: [],
          props: { new: true },
          attr: { id: "new-id" },
          old: {
            resourceType: "Test::Resource",
            logicalId: "Replaced",
            instanceId: "inst-old",
            providerVersion: 1,
            status: "created",
            downstream: [],
            props: { new: false },
            attr: { id: "old-id" },
          },
          deleteFirst: false,
        };

        yield* state.set({
          stack: "replaced-test-stack",
          stage: "test-stage",
          resourceId: "Created",
          value: createdState,
        });

        yield* state.set({
          stack: "replaced-test-stack",
          stage: "test-stage",
          resourceId: "Replaced",
          value: replacedState,
        });

        // Get replaced resources
        const replaced = yield* state.getReplacedResources({
          stack: "replaced-test-stack",
          stage: "test-stage",
        });

        expect(replaced).toHaveLength(1);
        expect(replaced[0].logicalId).toEqual("Replaced");
        expect(replaced[0].status).toEqual("replaced");

        // Clean up
        yield* state.delete({
          stack: "replaced-test-stack",
          stage: "test-stage",
          resourceId: "Created",
        });
        yield* state.delete({
          stack: "replaced-test-stack",
          stage: "test-stage",
          resourceId: "Replaced",
        });
      }).pipe(Effect.provide(testLayers)),
    { timeout: 30000 },
  );
});
