import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getDomain = (
  resourceGroupName: string,
  name: string,
  domainName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* web.GetStaticSiteStaticSiteCustomDomain({
      subscriptionId,
      resourceGroupName,
      name,
      domainName,
    });
  });

const domainGone = (
  resourceGroupName: string,
  name: string,
  domainName: string,
) =>
  getDomain(resourceGroupName, name, domainName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

// TXT-token validation issues a token without any DNS record, so the
// lifecycle runs against a domain nobody has to control.
const program = (domainName: string) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus2",
    });
    const site = yield* Azure.Web.StaticSite("Site", {
      resourceGroup: group.resourceGroupName,
    });
    const domain = yield* Azure.Web.StaticSiteCustomDomain("Domain", {
      resourceGroup: group.resourceGroupName,
      staticSiteName: site.staticSiteName,
      domainName,
      validationMethod: "dns-txt-token",
    });
    return { group, site, domain };
  });

const FIRST = "alchemy-web-swa-domain-1.example.com";
const SECOND = "alchemy-web-swa-domain-2.example.com";

// Cost: $0 (Free static site; domains pending validation cost nothing).
// Provisioning: ~1-2 minutes.
test.provider(
  "create, replace, and delete a static site custom domain",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, site, domain } = yield* stack.deploy(program(FIRST));
      expect(domain.domainName).toEqual(FIRST);
      expect(domain.validationMethod).toEqual("dns-txt-token");
      expect(domain.validationToken?.length ?? 0).toBeGreaterThan(0);
      const observed = yield* getDomain(
        group.resourceGroupName,
        site.staticSiteName,
        FIRST,
      );
      expect(observed.properties?.validationToken).toEqual(
        domain.validationToken,
      );
      expect(["Validating", "Ready"]).toContain(observed.properties?.status);

      // A redeploy without changes leaves the domain in place.
      const same = yield* stack.deploy(program(FIRST));
      expect(same.domain.customDomainId).toEqual(domain.customDomainId);

      // Replacement: a different domain name.
      const replaced = yield* stack.deploy(program(SECOND));
      expect(replaced.domain.domainName).toEqual(SECOND);
      const second = yield* getDomain(
        group.resourceGroupName,
        site.staticSiteName,
        SECOND,
      );
      expect(second.properties?.validationToken?.length ?? 0).toBeGreaterThan(
        0,
      );
      expect(
        yield* domainGone(group.resourceGroupName, site.staticSiteName, FIRST),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* domainGone(group.resourceGroupName, site.staticSiteName, SECOND),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 600_000,
  },
);
