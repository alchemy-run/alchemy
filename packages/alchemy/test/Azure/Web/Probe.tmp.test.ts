import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as web from "@distilled.cloud/azure/web";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Azure.providers() });

const show = (label: string) => <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  eff.pipe(
    Effect.map((v) => console.log("PROBE", label, "OK", JSON.stringify(v))),
    Effect.catch((e: any) =>
      Effect.sync(() =>
        console.log(
          "PROBE",
          label,
          "ERR",
          e?._tag,
          e?.code,
          e?.status,
          e?.message,
        ),
      ),
    ),
  );

test.provider(
  "probe web behaviours",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group, app } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          const plan = yield* Azure.Web.AppServicePlan("Plan", {
            resourceGroup: group.resourceGroupName,
            location: "centralus",
            sku: "F1",
            os: "linux",
          });
          const app = yield* Azure.Web.WebApp("Site", {
            resourceGroup: group.resourceGroupName,
            serverFarmId: plan.appServicePlanId,
            siteConfig: { linuxFxVersion: "SITECONTAINERS", alwaysOn: false },
          });
          return { group, app };
        }),
      );
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: group.resourceGroupName,
        name: app.siteName,
      };
      yield* show("sourcecontrol-get")(web.GetWebAppSourceControl(where));
      yield* show("swift-get")(web.GetWebAppSwiftVirtualNetworkConnection(where));
      yield* show("auth-get")(web.GetWebAppAuthSettingsV2(where));
      yield* show("container-get-missing")(
        web.GetWebAppSiteContainer({ ...where, containerName: "nope" }),
      );
      yield* show("container-put")(
        web.WebAppsCreateOrUpdateSiteContainer({
          ...where,
          containerName: "main",
          properties: {
            image: "mcr.microsoft.com/appsvc/staticsite:latest",
            targetPort: "80",
            isMain: true,
          },
        }),
      );
      yield* show("slot-put")(
        web.WebAppsCreateOrUpdateSlot({
          ...where,
          slot: "staging",
          location: app.location,
          properties: { serverFarmId: app.serverFarmId },
        }),
      );
      yield* show("hostname-put")(
        web.WebAppsCreateOrUpdateHostNameBinding({
          ...where,
          hostName: "alchemy-probe.example.com",
          properties: { siteName: app.siteName, hostNameType: "Verified" },
        }),
      );
      yield* show("hostname-get-missing")(
        web.GetWebAppHostNameBinding({
          ...where,
          hostName: "alchemy-probe.example.com",
        }),
      );
      yield* show("aigw-put")(
        web.AiGatewaysCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          name: "alchemy-probe-aigw",
          location: "eastus",
          properties: {},
        }),
      );
      yield* show("aigw-get")(
        web.GetAiGateway({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          name: "alchemy-probe-aigw",
        }),
      );
      yield* show("aigw-get-missing")(
        web.GetAiGateway({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          name: "alchemy-probe-missing",
        }),
      );
      yield* show("aigw-delete")(
        web.DeleteAiGateway({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          name: "alchemy-probe-aigw",
        }),
      );
      yield* stack.destroy();
    }),
  { tags: ["provider:azure", "live"], timeout: 600_000 },
);
