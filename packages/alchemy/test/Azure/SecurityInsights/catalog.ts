import * as Azure from "@/Azure";
import * as securityinsights from "@distilled.cloud/azure/securityinsights";
import * as Effect from "effect/Effect";

const base = (resourceGroupName: string, workspaceName: string) =>
  Effect.map(Azure.AzureEnvironment.current, ({ subscriptionId }) => ({
    subscriptionId,
    resourceGroupName,
    workspaceName,
  }));

/** Content Hub catalog entry of a solution, by display name. */
export const findProductPackage = (
  resourceGroupName: string,
  workspaceName: string,
  displayName: string,
) =>
  Effect.gen(function* () {
    const page = yield* securityinsights.ListProductPackages({
      ...(yield* base(resourceGroupName, workspaceName)),
      _filter: `properties/displayName eq '${displayName}'`,
    });
    const pkg = page.value.find(
      (p) => p.properties?.contentKind === "Solution",
    );
    if (pkg?.properties === undefined) {
      return yield* Effect.die(new Error(`no catalog package ${displayName}`));
    }
    return pkg.properties;
  });

/** Props of a ContentPackage installing a catalog package. */
export const packageProps = (
  pkg: securityinsights.ProductPackageProperties,
) => ({
  packageId: pkg.contentId!,
  contentId: pkg.contentId!,
  contentProductId: pkg.contentProductId!,
  contentKind: pkg.contentKind ?? "Solution",
  version: pkg.version!,
  displayName: pkg.displayName!,
  publisherDisplayName: pkg.publisherDisplayName,
  source: pkg.source,
  author: pkg.author,
  support: pkg.support,
  contentSchemaVersion: pkg.contentSchemaVersion,
});

/** Analytics-rule templates of a catalog package, with their packaged content. */
export const productTemplates = (
  resourceGroupName: string,
  workspaceName: string,
  packageId: string,
  count: number,
) =>
  Effect.gen(function* () {
    const b = yield* base(resourceGroupName, workspaceName);
    const page = yield* securityinsights.ListProductTemplates({
      ...b,
      _filter: `properties/packageId eq '${packageId}' and properties/contentKind eq 'AnalyticsRule'`,
      _top: count,
    });
    return yield* Effect.forEach(page.value.slice(0, count), (t) =>
      securityinsights.GetProductTemplate({ ...b, templateId: t.name! }),
    );
  });
