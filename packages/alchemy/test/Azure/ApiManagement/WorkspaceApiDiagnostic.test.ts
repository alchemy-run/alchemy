import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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
    apim.GetWorkspaceApiDiagnostic({
      subscriptionId,
      resourceGroupName,
      serviceName,
      workspaceId: "alchemy-ws",
      apiId: "alchemy-api",
      diagnosticId: "applicationinsights",
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
    const api = yield* Azure.ApiManagement.WorkspaceApi("Api", {
      ...base,
      name: "alchemy-api",
      path: "api",
      serviceUrl: "https://example.com",
    });
    // APIM stores Application Insights keys without validating them.
    const logger = yield* Azure.ApiManagement.WorkspaceLogger("Insights", {
      ...base,
      name: "alchemy-logger",
      loggerType: "applicationInsights",
      credentials: {
        instrumentationKey: Redacted.make(
          "00000000-0000-4000-8000-000000000081",
        ),
      },
    });
    const created =
      variant === undefined
        ? undefined
        : yield* Azure.ApiManagement.WorkspaceApiDiagnostic("Entity", {
            ...base,
            apiName: api.apiName,
            loggerId: logger.loggerId,
            sampling: {
              samplingType: "fixed",
              percentage: variant === "one" ? 50 : 25,
            },
          });
    return { group, service, created };
  });

// Workspaces need BasicV2/StandardV2/Premium ("Method not allowed in
// Consumption pricing tier"). A BasicV2 service bills ~$0.21/h and takes
// 5-15+ minutes to create: est. ~$0.10 and ~25 minutes per run.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a WorkspaceApiDiagnostic",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program("one"));
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.created).toBeDefined();
      const one = yield* get(rg, svc, "one");
      expect(one.properties?.sampling?.percentage).toEqual(50);

      // In-place update.
      yield* stack.deploy(program("two"));
      const two = yield* get(rg, svc, "two");
      expect(two.properties?.sampling?.percentage).toEqual(25);

      // Removing the resource deletes it.
      yield* stack.deploy(program());
      expect(yield* untilGone(get(rg, svc, "two"))).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
