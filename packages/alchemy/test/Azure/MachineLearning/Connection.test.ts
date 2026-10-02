import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as ml from "@distilled.cloud/azure/machinelearningservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  baseWorkspace,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConnection = (
  resourceGroupName: string,
  workspaceName: string,
  connectionName: string,
) =>
  Effect.gen(function* () {
    return yield* ml.GetWorkspaceConnection({
      subscriptionId: yield* subscription,
      resourceGroupName,
      workspaceName,
      connectionName,
    });
  });

const program = (props: {
  kind: "ApiKey" | "CustomKeys";
  target: string;
  secret: string;
  metadata: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const base = yield* baseWorkspace();
    const connection = yield* Azure.MachineLearning.Connection("Api", {
      resourceGroup: base.group.resourceGroupName,
      workspace: base.workspace.workspaceName,
      category: props.kind,
      authType: props.kind,
      target: props.target,
      credentials:
        props.kind === "ApiKey"
          ? { key: props.secret }
          : { keys: { token: props.secret } },
      metadata: props.metadata,
    });
    return { ...base, connection };
  });

// Connections are free; the hub workspace has no hourly charge. ~3-5 minutes.
test.provider(
  "create, update, replace, and delete a workspace connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, connection } = yield* stack.deploy(
        program({
          kind: "ApiKey",
          target: "https://api.example.com",
          secret: "secret-1",
          metadata: { purpose: "test" },
        }),
      );
      const get = (name: string) =>
        getConnection(group.resourceGroupName, workspace.workspaceName, name);
      expect(connection.authType).toEqual("ApiKey");
      const observed = yield* get(connection.connectionName);
      expect(observed.properties.target).toEqual("https://api.example.com");
      expect(observed.properties.category).toEqual("ApiKey");
      expect(observed.properties.metadata?.purpose).toEqual("test");
      expect(observed.properties.metadata?.["alchemy::id"]).toEqual("Api");

      // In-place: target, credentials, and metadata.
      const updated = yield* stack.deploy(
        program({
          kind: "ApiKey",
          target: "https://api2.example.com",
          secret: "secret-2",
          metadata: { purpose: "prod" },
        }),
      );
      expect(updated.connection.connectionId).toEqual(connection.connectionId);
      const reobserved = yield* get(connection.connectionName);
      expect(reobserved.properties.target).toEqual("https://api2.example.com");
      expect(reobserved.properties.metadata?.purpose).toEqual("prod");
      const secrets = yield* ml.ListWorkspaceConnectionSecrets({
        subscriptionId: yield* subscription,
        resourceGroupName: group.resourceGroupName,
        workspaceName: workspace.workspaceName,
        connectionName: connection.connectionName,
      });
      expect(JSON.stringify(secrets)).toContain("secret-2");

      // Replacement: a new auth type.
      const replaced = yield* stack.deploy(
        program({
          kind: "CustomKeys",
          target: "https://api2.example.com",
          secret: "secret-3",
          metadata: { purpose: "prod" },
        }),
      );
      expect(replaced.connection.authType).toEqual("CustomKeys");
      const replacedObserved = yield* get(replaced.connection.connectionName);
      expect(replacedObserved.properties.authType).toEqual("CustomKeys");
      if (replaced.connection.connectionName !== connection.connectionName) {
        expect(yield* waitGone(get(connection.connectionName))).toEqual("gone");
      }

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.connection.connectionName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
