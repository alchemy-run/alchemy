import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as healthcareapis from "@distilled.cloud/azure/healthcareapis";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runExpensive } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getDicom = (
  resourceGroupName: string,
  workspaceName: string,
  dicomServiceName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* healthcareapis.GetDicomService({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      dicomServiceName,
    });
  });

const dicomGone = (
  resourceGroupName: string,
  workspaceName: string,
  dicomServiceName: string,
) =>
  getDicom(resourceGroupName, workspaceName, dicomServiceName).pipe(
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
      location: "eastus",
    });
    const workspace = yield* Azure.HealthcareApis.Workspace("Workspace", {
      resourceGroup: group.resourceGroupName,
    });
    const dicom = yield* Azure.HealthcareApis.DicomService("Dicom", {
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
    return { group, workspace, dicom };
  });

// Consumption billed (~$0 for an empty service), but first-time
// provisioning takes ~10-15 minutes. The engine-default
// resource group name is 90 characters, so the provider shortens generated
// service names to keep the service's resource ID within 253 characters;
// 257+ character IDs end in provisioning state 'Failed' after ~30-40 min.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a DICOM service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, dicom } = yield* stack.deploy(
        program({
          origins: ["https://app.example.com"],
          tags: { env: "test" },
        }),
      );
      expect(dicom.serviceUrl).toEqual(
        `https://${workspace.workspaceName}-${dicom.dicomServiceName}.dicom.azurehealthcareapis.com`,
      );
      expect(dicom.dicomServiceId.length).toBeLessThanOrEqual(253);
      expect(dicom.audiences.length).toBeGreaterThan(0);
      expect(dicom.enableDataPartitions).toEqual(false);
      expect(dicom.tags).toEqual({ env: "test" });

      const observed = yield* getDicom(
        group.resourceGroupName,
        workspace.workspaceName,
        dicom.dicomServiceName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.corsConfiguration?.origins).toEqual([
        "https://app.example.com",
      ]);
      expect(observed.tags?.alchemy_id).toEqual("Dicom");

      // In-place updates: CORS origins and tags.
      const updated = yield* stack.deploy(
        program({
          origins: ["https://app.example.com", "https://admin.example.com"],
          tags: { env: "prod" },
        }),
      );
      expect(updated.dicom.dicomServiceId).toEqual(dicom.dicomServiceId);
      expect(updated.dicom.tags).toEqual({ env: "prod" });
      const reobserved = yield* getDicom(
        group.resourceGroupName,
        workspace.workspaceName,
        dicom.dicomServiceName,
      );
      expect(reobserved.properties?.corsConfiguration?.origins).toEqual([
        "https://app.example.com",
        "https://admin.example.com",
      ]);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* dicomGone(
          group.resourceGroupName,
          workspace.workspaceName,
          dicom.dicomServiceName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:healthcareapis", "live"],
    // First-time FHIR/DICOM provisioning can take 25-40 minutes.
    timeout: 5_400_000,
  },
);
