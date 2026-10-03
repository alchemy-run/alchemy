import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as portal from "@distilled.cloud/azure/portal";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runPaidOnly } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getDashboard = (resourceGroupName: string, dashboardName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* portal.GetDashboard({
      subscriptionId,
      resourceGroupName,
      dashboardName,
    });
  });

const dashboardGone = (resourceGroupName: string, dashboardName: string) =>
  getDashboard(resourceGroupName, dashboardName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const markdownLens = (content: string): Azure.Portal.DashboardLens => ({
  order: 0,
  parts: [
    {
      position: { x: 0, y: 0, colSpan: 6, rowSpan: 4 },
      metadata: {
        type: "Extension/HubsExtension/PartType/MarkdownPart",
        inputs: [],
        settings: {
          content: {
            content,
            title: "Notes",
            subtitle: "",
            markdownSource: 1,
          },
        },
      },
    },
  ],
});

const markdownOf = (lenses: unknown) =>
  (
    lenses as
      | {
          parts: {
            metadata?: { settings?: { content?: { content?: string } } };
          }[];
        }[]
      | undefined
  )?.[0]?.parts[0]?.metadata?.settings?.content?.content;

const program = (props: {
  location: string;
  title: string;
  content: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const dashboard = yield* Azure.Portal.Dashboard("Overview", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      title: props.title,
      lenses: [markdownLens(props.content)],
      tags: props.tags,
    });
    return { group, dashboard };
  });

test.provider(
  "probe: the trial subscription's Microsoft.Portal dashboards endpoint is blocked",
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
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const result = yield* portal
        .DashboardsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          dashboardName: "probe",
          location: "eastus",
          properties: { lenses: [] },
        })
        .pipe(
          Effect.flip,
          Effect.catch(() =>
            Effect.succeed({ _tag: "Created", message: "" } as const),
          ),
        );
      // Deleting the group removes the dashboard if the endpoint unblocks.
      yield* stack.destroy();
      expect(result._tag).toEqual("BadGateway");
      expect(result.message).toContain("The request is blocked");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:portal", "live"],
    timeout: 300_000,
  },
);

// Free (dashboards have no charge) and seconds to provision, but every
// Microsoft.Portal/dashboards call on the free-trial subscription returns a
// 502 HTML "The request is blocked." page (all api-versions, all regions),
// so the lifecycle only runs with AZURE_TEST_PAID=1.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete a portal dashboard",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({
          location: "eastus",
          title: "Alchemy test",
          content: "# Hello",
          tags: { env: "test" },
        }),
      );
      const { dashboard, group } = created;
      expect(dashboard.title).toEqual("Alchemy test");
      expect(dashboard.tags).toEqual({ env: "test" });
      expect(dashboard.portalUrl).toContain(dashboard.dashboardId);

      const observed = yield* getDashboard(
        group.resourceGroupName,
        dashboard.dashboardName,
      );
      expect(observed.tags?.["hidden-title"]).toEqual("Alchemy test");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Overview");
      expect(markdownOf(observed.properties?.lenses)).toEqual("# Hello");

      // In-place update: markdown content, title, and tags.
      const updated = yield* stack.deploy(
        program({
          location: "eastus",
          title: "Alchemy test v2",
          content: "# Updated",
          tags: { env: "prod" },
        }),
      );
      expect(updated.dashboard.dashboardId).toEqual(dashboard.dashboardId);
      expect(updated.dashboard.title).toEqual("Alchemy test v2");
      const reobserved = yield* getDashboard(
        group.resourceGroupName,
        dashboard.dashboardName,
      );
      expect(reobserved.tags?.["hidden-title"]).toEqual("Alchemy test v2");
      expect(reobserved.tags?.env).toEqual("prod");
      expect(markdownOf(reobserved.properties?.lenses)).toEqual("# Updated");

      // Replacement: location is immutable.
      const replaced = yield* stack.deploy(
        program({
          location: "westus2",
          title: "Alchemy test v2",
          content: "# Updated",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.dashboard.location.toLowerCase()).toEqual("westus2");
      const moved = yield* getDashboard(
        group.resourceGroupName,
        replaced.dashboard.dashboardName,
      );
      expect(moved.location.toLowerCase()).toEqual("westus2");

      yield* stack.destroy();
      expect(
        yield* dashboardGone(
          group.resourceGroupName,
          replaced.dashboard.dashboardName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:portal", "live"],
    timeout: 600_000,
  },
);
