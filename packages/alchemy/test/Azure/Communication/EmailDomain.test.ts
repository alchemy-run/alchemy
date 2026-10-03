import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as communication from "@distilled.cloud/azure/communication";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getDomain = (
  resourceGroupName: string,
  emailServiceName: string,
  domainName: string,
) =>
  Effect.gen(function* () {
    return yield* communication.GetDomain({
      subscriptionId: yield* subscription,
      resourceGroupName,
      emailServiceName,
      domainName,
    });
  });

const program = (props: {
  emailService: "A" | "B";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Both email services stay deployed across the replacement step.
    const a = yield* Azure.Communication.EmailService("EmailA", {
      resourceGroup: group.resourceGroupName,
    });
    const b = yield* Azure.Communication.EmailService("EmailB", {
      resourceGroup: group.resourceGroupName,
    });
    const email = props.emailService === "A" ? a : b;
    const domain = yield* Azure.Communication.EmailDomain("Domain", {
      resourceGroup: group.resourceGroupName,
      emailService: email.emailServiceName,
      tags: props.tags,
    });
    return { group, email, domain };
  });

// Azure-managed domains are free; ~1-3 minutes.
test.provider(
  "create, update, replace, and delete an Azure-managed email domain",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, email, domain } = yield* stack.deploy(
        program({ emailService: "A", tags: { env: "test" } }),
      );
      const rg = group.resourceGroupName;
      expect(domain.domainName).toEqual("AzureManagedDomain");
      expect(domain.domainManagement).toEqual("AzureManaged");
      expect(domain.fromSenderDomain).toMatch(/azurecomm\.net$/);
      const observed = yield* getDomain(
        rg,
        email.emailServiceName,
        domain.domainName,
      );
      expect(observed.tags?.env).toEqual("test");

      // In-place: tags.
      const updated = yield* stack.deploy(
        program({ emailService: "A", tags: { env: "prod" } }),
      );
      expect(updated.domain.domainId).toEqual(domain.domainId);
      const reobserved = yield* getDomain(
        rg,
        email.emailServiceName,
        domain.domainName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: moving to another email service.
      const replaced = yield* stack.deploy(
        program({ emailService: "B", tags: { env: "prod" } }),
      );
      expect(replaced.domain.emailService).toEqual(
        replaced.email.emailServiceName,
      );
      expect(replaced.domain.domainId).not.toEqual(domain.domainId);
      expect(
        yield* waitGone(
          getDomain(rg, email.emailServiceName, domain.domainName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getDomain(
            rg,
            replaced.email.emailServiceName,
            replaced.domain.domainName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
