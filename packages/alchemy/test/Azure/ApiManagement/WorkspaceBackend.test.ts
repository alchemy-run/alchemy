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
    apim.GetWorkspaceBackend({
      subscriptionId,
      resourceGroupName,
      serviceName,
      workspaceId: "alchemy-ws",
      backendId: "alchemy-backend",
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
        : yield* Azure.ApiManagement.WorkspaceBackend("Entity", {
            ...base,
            name: "alchemy-backend",
            url: `https://${variant}.example.com`,
          });
    return { group, service, created };
  });

// Workspaces need BasicV2/StandardV2/Premium ("Method not allowed in
// Consumption pricing tier"). A BasicV2 service bills ~$0.21/h and takes
// 5-15+ minutes to create: est. ~$0.10 and ~25 minutes per run.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a WorkspaceBackend",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program("one"));
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.created).toBeDefined();
      const one = yield* get(rg, svc, "one");
      expect(one.properties?.url).toEqual("https://one.example.com");

      // In-place update.
      yield* stack.deploy(program("two"));
      const two = yield* get(rg, svc, "two");
      expect(two.properties?.url).toEqual("https://two.example.com");

      // Removing the resource deletes it.
      yield* stack.deploy(program());
      expect(yield* untilGone(get(rg, svc, "two"))).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
