import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { getConnection, logLevel, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  justification: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const pipeline = yield* Azure.DataTransfer.Pipeline("Pipeline", {
      resourceGroup: group.resourceGroupName,
      remoteCloud: "Public",
    });
    const connection = yield* Azure.DataTransfer.Connection("Connection", {
      resourceGroup: group.resourceGroupName,
      pipeline: pipeline.pipelineName,
      direction: "Send",
      justification: props.justification,
      primaryContact: "alchemy-test@example.com",
      flowTypes: ["Mission"],
      tags: props.tags,
    });
    return { group, pipeline, connection };
  });

// Needs a subscription onboarded to Azure Data Transfer to create the
// pipeline the connection targets. Pipelines and connections are free;
// billing is per transferred GB.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete a connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, connection } = yield* stack.deploy(
        program({ justification: "first", tags: { env: "test" } }),
      );
      const get = (name: string) =>
        getConnection(group.resourceGroupName, name);
      const observed = yield* get(connection.connectionName);
      expect(observed.properties?.direction).toEqual("Send");
      expect(observed.properties?.justification).toEqual("first");
      expect(observed.tags?.env).toEqual("test");

      // In place: tags are patched.
      const updated = yield* stack.deploy(
        program({ justification: "first", tags: { env: "prod" } }),
      );
      expect(updated.connection.connectionId).toEqual(connection.connectionId);
      expect((yield* get(connection.connectionName)).tags?.env).toEqual("prod");

      // Replacement: the request is create-only.
      const replaced = yield* stack.deploy(
        program({ justification: "second", tags: { env: "prod" } }),
      );
      expect(replaced.connection.connectionName).not.toEqual(
        connection.connectionName,
      );
      expect(
        (yield* get(replaced.connection.connectionName)).properties
          ?.justification,
      ).toEqual("second");
      expect(yield* waitGone(get(connection.connectionName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.connection.connectionName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free, ~1 minute): a connection to a pipeline that does not
// exist is accepted and then fails provisioning; the provider surfaces
// Azure.ProvisioningFailed, and destroy still removes the failed connection.
test.provider(
  "a connection to a missing pipeline fails provisioning and is cleaned up",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            const group = yield* Azure.Resources.ResourceGroup("Group", {
              location: "eastus",
            });
            const connection = yield* Azure.DataTransfer.Connection(
              "Connection",
              {
                resourceGroup: group.resourceGroupName,
                name: "alchemy-missing-pipeline-probe",
                pipeline: "alchemy-missing-pipeline",
                direction: "Send",
                justification: "probe",
                primaryContact: "alchemy-test@example.com",
                tags: { env: "probe" },
              },
            );
            return { group, connection };
          }),
        )
        .pipe(Effect.flip);
      expect(JSON.stringify(error)).toContain("Azure.ProvisioningFailed");

      const get = getConnection(
        group.resourceGroupName,
        "alchemy-missing-pipeline-probe",
      );
      const observed = yield* get;
      expect(observed.properties?.provisioningState).toEqual("Failed");
      expect(observed.properties?.pipeline).toEqual("alchemy-missing-pipeline");
      expect(observed.tags?.env).toEqual("probe");
      expect(observed.tags?.["alchemy::id"]).toEqual("Connection");

      // Destroy deletes the failed connection (the group goes with it, so
      // wait on the connection first).
      yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      expect(yield* waitGone(get)).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
