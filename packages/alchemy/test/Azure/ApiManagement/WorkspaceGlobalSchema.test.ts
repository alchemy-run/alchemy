import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import {
  basicV2Workspace,
  logLevel,
  subscriptionId,
  tags,
  untilGone,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

type Variant = "one" | "two";

const get = (
  resourceGroupName: string,
  serviceName: string,
  variant: Variant,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetWorkspaceGlobalSchema({
      subscriptionId,
      resourceGroupName,
      serviceName,
      workspaceId: "alchemy-ws",
      schemaId: "alchemy-schema",
    }),
  );

const program = (variant?: Variant) =>
  Effect.gen(function* () {
    const { group, service, workspace } = yield* basicV2Workspace;
    const base = {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      workspaceName: workspace.workspaceName,
    };

    const created =
      variant === undefined
        ? undefined
        : yield* Azure.ApiManagement.WorkspaceGlobalSchema("Entity", {
            ...base,
            name: "alchemy-schema",
            schemaType: "json",
            document: {
              type: "object",
              properties: { [variant]: { type: "string" } },
            },
          });
    return { group, service, created };
  });

// Workspaces need BasicV2/StandardV2/Premium ("Method not allowed in
// Consumption pricing tier"). A BasicV2 service bills ~$0.21/h and takes
// 5-15+ minutes to create: est. ~$0.10 and ~25 minutes per run.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a WorkspaceGlobalSchema",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program("one"));
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.created).toBeDefined();
      const one = yield* get(rg, svc, "one");
      expect(JSON.stringify(one.properties)).toContain("one");

      // In-place update.
      yield* stack.deploy(program("two"));
      const two = yield* get(rg, svc, "two");
      expect(JSON.stringify(two.properties)).toContain("two");

      // Removing the resource deletes it.
      yield* stack.deploy(program());
      expect(yield* untilGone(get(rg, svc, "two"))).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
