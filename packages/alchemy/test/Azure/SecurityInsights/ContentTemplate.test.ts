import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as securityinsights from "@distilled.cloud/azure/securityinsights";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  findProductPackage,
  packageProps,
  productTemplates,
} from "./catalog.ts";
import { pollGone, sentinelWorkspace, tags } from "./sentinel.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getTemplate = (
  resourceGroupName: string,
  workspaceName: string,
  templateId: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* securityinsights.GetContentTemplate({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      templateId,
    });
  });

const templateGone = (rg: string, ws: string, id: string) =>
  pollGone(
    getTemplate(rg, ws, id).pipe(
      Effect.as("found" as const),
      Effect.catchTag(
        ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
        () => Effect.succeed("gone" as const),
      ),
    ),
  );

type PackageProps = ReturnType<typeof packageProps>;

const templateProps = (
  t: securityinsights.GetProductTemplateResponse,
  displayName?: string,
) => {
  const p = t.properties!;
  return {
    templateId: t.name!,
    contentId: p.contentId!,
    contentProductId: p.contentProductId!,
    contentKind: p.contentKind ?? "AnalyticsRule",
    version: p.version!,
    displayName: displayName ?? p.displayName!,
    packageId: p.packageId,
    packageVersion: p.packageVersion,
    packageKind: p.packageKind,
    packageName: p.packageName,
    mainTemplate: p.packagedContent as Record<string, unknown>,
    source: p.source,
    author: p.author,
    support: p.support,
    contentSchemaVersion: p.contentSchemaVersion,
  };
};

const program = (
  pkg?: PackageProps,
  template?: ReturnType<typeof templateProps>,
) =>
  Effect.gen(function* () {
    const { group, logs, sentinel } = yield* sentinelWorkspace;
    const installed = pkg
      ? yield* Azure.SecurityInsights.ContentPackage("Solution", {
          resourceGroup: sentinel.resourceGroup,
          workspace: sentinel.workspace,
          ...pkg,
        })
      : undefined;
    const tpl =
      installed && template
        ? yield* Azure.SecurityInsights.ContentTemplate("Template", {
            resourceGroup: installed.resourceGroup,
            workspace: installed.workspace,
            ...template,
            packageId: installed.packageId,
          })
        : undefined;
    return { group, logs, installed, tpl };
  });

// Free Microsoft-published solution on an empty Sentinel workspace: ~$0, ~4 minutes.
test.provider(
  "install, update, replace, and delete a Content Hub template",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const bare = yield* stack.deploy(program());
      const rg = bare.group.resourceGroupName;
      const ws = bare.logs.workspaceName;
      const pkg = packageProps(
        yield* findProductPackage(rg, ws, "Azure Activity"),
      );
      const [first, second] = yield* productTemplates(
        rg,
        ws,
        pkg.packageId,
        2,
      );
      const firstProps = templateProps(first!);

      const created = yield* stack.deploy(program(pkg, firstProps));
      const templateId = created.tpl!.templateId;
      const observed = yield* getTemplate(rg, ws, templateId);
      expect(observed.properties?.contentId).toEqual(firstProps.contentId);
      expect(observed.properties?.version).toEqual(firstProps.version);

      yield* stack.deploy(
        program(pkg, templateProps(first!, "Alchemy renamed template")),
      );
      const after = yield* getTemplate(rg, ws, templateId);
      expect(after.properties?.displayName).toEqual("Alchemy renamed template");

      const replaced = yield* stack.deploy(
        program(pkg, templateProps(second!)),
      );
      expect(replaced.tpl!.templateId).not.toEqual(templateId);
      expect(yield* templateGone(rg, ws, templateId)).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* templateGone(rg, ws, replaced.tpl!.templateId),
      ).toEqual("gone");
    }),
  { tags, timeout: 900_000 },
);
