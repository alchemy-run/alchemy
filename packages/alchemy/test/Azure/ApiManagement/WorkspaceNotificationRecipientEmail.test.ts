import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { runExpensive } from "../gates.ts";
import { basicV2Workspace, logLevel, subscriptionId, tags } from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const recipients = (resourceGroupName: string, serviceName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.ListWorkspaceNotificationRecipientEmailByNotification({
      subscriptionId,
      resourceGroupName,
      serviceName,
      workspaceId: "alchemy-ws",
      notificationName: "BCC",
    }),
  ).pipe(
    Effect.map((page) =>
      (page.value ?? []).map((r) => r.properties?.email ?? ""),
    ),
  );

/** Poll until the BCC recipients match `expected` (bounded). */
const untilRecipients = (
  resourceGroupName: string,
  serviceName: string,
  expected: string[],
) =>
  recipients(resourceGroupName, serviceName).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (emails) => emails.sort().join(",") === expected.sort().join(","),
      times: 10,
    }),
  );

const program = (email?: string) =>
  Effect.gen(function* () {
    const { group, service, workspace } = yield* basicV2Workspace;
    const recipient = email
      ? yield* Azure.ApiManagement.WorkspaceNotificationRecipientEmail("Team", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          workspaceName: workspace.workspaceName,
          notificationName: "BCC",
          email,
        })
      : undefined;
    return { group, service, recipient };
  });

// Workspaces need BasicV2/StandardV2/Premium ("Method not allowed in
// Consumption pricing tier"). A BasicV2 service bills ~$0.21/h and takes
// 5-15+ minutes to create: est. ~$0.10 and ~25 minutes per run.
test.provider.skipIf(!runExpensive)(
  "subscribe, replace, and unsubscribe a workspace notification email",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program("one@example.com"));
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.recipient?.email).toEqual("one@example.com");
      expect(yield* untilRecipients(rg, svc, ["one@example.com"])).toEqual([
        "one@example.com",
      ]);

      // Replacement: a new address subscribes, the old one is removed.
      yield* stack.deploy(program("two@example.com"));
      expect(yield* untilRecipients(rg, svc, ["two@example.com"])).toEqual([
        "two@example.com",
      ]);

      // Removing the resource unsubscribes the address.
      yield* stack.deploy(program());
      expect(yield* untilRecipients(rg, svc, [])).toEqual([]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
