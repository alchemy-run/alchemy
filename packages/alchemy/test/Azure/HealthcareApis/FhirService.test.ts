import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as healthcareapis from "@distilled.cloud/azure/healthcareapis";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runPaidOnly } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getFhir = (
  resourceGroupName: string,
  workspaceName: string,
  fhirServiceName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* healthcareapis.GetFhirService({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      fhirServiceName,
    });
  });

const fhirGone = (
  resourceGroupName: string,
  workspaceName: string,
  fhirServiceName: string,
) =>
  getFhir(resourceGroupName, workspaceName, fhirServiceName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times: 30,
    }),
  );

const program = (props: { origins: string[]; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "westus2",
    });
    const workspace = yield* Azure.HealthcareApis.Workspace("Workspace", {
      resourceGroup: group.resourceGroupName,
    });
    const fhir = yield* Azure.HealthcareApis.FhirService("Fhir", {
      resourceGroup: group.resourceGroupName,
      workspace: workspace.workspaceName,
      corsConfiguration: {
        origins: props.origins,
        headers: ["*"],
        methods: ["GET", "POST"],
        maxAge: 600,
        allowCredentials: false,
      },
      tags: props.tags,
    });
    return { group, workspace, fhir };
  });

// Consumption billed (~$0 for an empty service). On the free-trial
// subscription every FHIR create (eastus and westus2) sat in 'Creating' for
// ~40 minutes and then ended in provisioning state 'Failed' (activity log:
// ResourceOperationFailure, no further detail), so the lifecycle only runs
// on an upgraded subscription. No ungated probe: the rejection is an async
// provisioning failure after ~30 minutes, not a synchronous typed error.
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete a FHIR service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, fhir } = yield* stack.deploy(
        program({
          origins: ["https://app.example.com"],
          tags: { env: "test" },
        }),
      );
      expect(fhir.kind).toEqual("fhir-R4");
      expect(fhir.serviceUrl).toEqual(
        `https://${workspace.workspaceName}-${fhir.fhirServiceName}.fhir.azurehealthcareapis.com`,
      );
      expect(fhir.audience).toEqual(fhir.serviceUrl);
      expect(fhir.tags).toEqual({ env: "test" });

      const observed = yield* getFhir(
        group.resourceGroupName,
        workspace.workspaceName,
        fhir.fhirServiceName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.corsConfiguration?.origins).toEqual([
        "https://app.example.com",
      ]);
      expect(observed.tags?.alchemy_id).toEqual("Fhir");

      // The capability statement is served without authentication.
      const client = yield* HttpClient.HttpClient;
      const metadata = yield* client.get(`${fhir.serviceUrl}/metadata`).pipe(
        Effect.flatMap((res) =>
          res.status === 200 ? Effect.succeed(res) : Effect.fail(res.status),
        ),
        Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 12 }),
      );
      const statement = (yield* metadata.json) as { resourceType: string };
      expect(statement.resourceType).toEqual("CapabilityStatement");

      // In-place updates: CORS origins and tags.
      const updated = yield* stack.deploy(
        program({
          origins: ["https://app.example.com", "https://admin.example.com"],
          tags: { env: "prod" },
        }),
      );
      expect(updated.fhir.fhirServiceId).toEqual(fhir.fhirServiceId);
      expect(updated.fhir.tags).toEqual({ env: "prod" });
      const reobserved = yield* getFhir(
        group.resourceGroupName,
        workspace.workspaceName,
        fhir.fhirServiceName,
      );
      expect(reobserved.properties?.corsConfiguration?.origins).toEqual([
        "https://app.example.com",
        "https://admin.example.com",
      ]);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* fhirGone(
          group.resourceGroupName,
          workspace.workspaceName,
          fhir.fhirServiceName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:healthcareapis", "live"],
    timeout: 900_000,
  },
);
