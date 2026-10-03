import * as Azure from "@/Azure";
import { ensureRegistered } from "@/Azure/Arm";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as storage from "@distilled.cloud/azure/storage";
import { Credentials } from "@distilled.cloud/azure/Credentials";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const TASK_NAME = "alchemystatest";
const LOCATION = "eastus";

const getAssignment = (rg: string, account: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* storage.GetStorageTaskAssignment({
      subscriptionId,
      resourceGroupName: rg,
      accountName: account,
      storageTaskAssignmentName: name,
    });
  });

const assignmentGone = (rg: string, account: string, name: string) =>
  getAssignment(rg, account, name).pipe(
    Effect.as("found" as const),
    Effect.catchTag("ResourceNotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 20,
    }),
  );

/**
 * The Storage Actions task is a prerequisite from another service that
 * Alchemy does not implement yet; create it out of band in the stack's
 * resource group. Raw ARM calls: the generated storageactions SDK pins
 * api-version 2026-03-01, which ARM does not serve yet (only 2023-01-01).
 */
const TASK_API_VERSION = "2023-01-01";

interface ArmTask {
  id: string;
  identity?: { principalId?: string };
  properties?: { provisioningState?: string };
}

const taskRequest = (
  method: "GET" | "PUT" | "DELETE",
  rg: string,
  body?: unknown,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const credentials = yield* yield* Credentials;
    const client = yield* HttpClient.HttpClient;
    const url = `${credentials.apiBaseUrl}/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.StorageActions/storageTasks/${TASK_NAME}?api-version=${TASK_API_VERSION}`;
    let request = HttpClientRequest.make(method)(url).pipe(
      HttpClientRequest.bearerToken(Redacted.value(credentials.bearerToken)),
    );
    if (body !== undefined) {
      request = request.pipe(HttpClientRequest.bodyJsonUnsafe(body));
    }
    const response = yield* client.execute(request);
    const text = yield* response.text;
    return {
      status: response.status,
      text,
      json: text.length > 0 ? (JSON.parse(text) as ArmTask) : undefined,
    };
  });

const ensureTask = (rg: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    yield* ensureRegistered(subscriptionId, "Microsoft.StorageActions");
    const put = yield* taskRequest("PUT", rg, {
      location: LOCATION,
      identity: { type: "SystemAssigned" },
      properties: {
        enabled: true,
        description: "alchemy storage task assignment test",
        action: {
          if: {
            condition: "[[endsWith(Name, '.tmp')]]",
            operations: [
              { name: "DeleteBlob", onSuccess: "continue", onFailure: "break" },
            ],
          },
        },
      },
    });
    expect(`${put.status} ${put.text}`).toMatch(/^2\d\d /);
    const task = yield* taskRequest("GET", rg).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("3 seconds"),
        until: (res) =>
          res.json?.properties?.provisioningState === "Succeeded" &&
          res.json.identity?.principalId !== undefined,
        times: 40,
      }),
    );
    return task.json!;
  });

const deleteTask = (rg: string) =>
  Effect.gen(function* () {
    yield* taskRequest("DELETE", rg);
    const final = yield* taskRequest("GET", rg).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("3 seconds"),
        until: (res) => res.status === 404,
        times: 20,
      }),
    );
    return final.status === 404 ? "gone" : "found";
  });

interface Assigned {
  taskId: string;
  principalId: string;
  description: string;
  enabled: boolean;
}

const program = (assigned?: Assigned) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const account = yield* Azure.Storage.StorageAccount("Account", {
      resourceGroup: group.resourceGroupName,
    });
    const reports = yield* Azure.Storage.BlobContainer("Reports", {
      resourceGroup: group.resourceGroupName,
      storageAccount: account.storageAccountName,
    });
    if (assigned === undefined) return { group, account, reports };
    const grant = yield* Azure.Authorization.RoleAssignment("TaskGrant", {
      scope: account.storageAccountId,
      roleDefinitionId: Azure.Authorization.BuiltInRole.StorageBlobDataOwner,
      principalId: assigned.principalId,
      principalType: "ServicePrincipal",
    });
    const assignment = yield* Azure.Storage.StorageTaskAssignment("Cleanup", {
      resourceGroup: group.resourceGroupName,
      storageAccount: account.storageAccountName,
      taskId: assigned.taskId,
      description: assigned.description,
      enabled: assigned.enabled,
      reportPrefix: reports.containerName,
      prefix: [Output.interpolate`${reports.containerName}/tmp`],
      trigger: { type: "RunOnce", startOn: "2030-01-01T00:00:00Z" },
    });
    return { group, account, reports, grant, assignment };
  });

// Standard_LRS account + Storage Actions task that never runs (start date in
// 2030): ~$0, ~3 minutes.
test.provider(
  "create, update, and delete a storage task assignment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const base = yield* stack.deploy(program());
      const rg = base.group.resourceGroupName;
      const acct = base.account.storageAccountName;
      const task = yield* ensureTask(rg);
      const taskId = task.id;
      const principalId = task.identity!.principalId!;

      const created = yield* stack.deploy(
        program({
          taskId,
          principalId,
          description: "first",
          enabled: true,
        }),
      );
      const name = created.assignment!.storageTaskAssignmentName;
      expect(created.assignment!.description).toEqual("first");
      expect(created.assignment!.triggerType).toEqual("RunOnce");
      const observed = yield* getAssignment(rg, acct, name);
      expect(observed.properties?.taskId.toLowerCase()).toEqual(
        taskId.toLowerCase(),
      );
      expect(observed.properties?.enabled).toEqual(true);

      // In-place update of mutable properties.
      const updated = yield* stack.deploy(
        program({
          taskId,
          principalId,
          description: "second",
          enabled: false,
        }),
      );
      expect(updated.assignment!.storageTaskAssignmentName).toEqual(name);
      expect(updated.assignment!.enabled).toEqual(false);
      const reobserved = yield* getAssignment(rg, acct, name);
      expect(reobserved.properties?.description).toEqual("second");
      expect(reobserved.properties?.enabled).toEqual(false);

      // Removing the resource deletes the assignment.
      yield* stack.deploy(program());
      expect(yield* assignmentGone(rg, acct, name)).toEqual("gone");

      expect(yield* deleteTask(rg)).toEqual("gone");
      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:storage", "live"],
    timeout: 900_000,
  },
);
