import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as communication from "@distilled.cloud/azure/communication";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getEmailService = (resourceGroupName: string, emailServiceName: string) =>
  Effect.gen(function* () {
    return yield* communication.GetEmailService({
      subscriptionId: yield* subscription,
      resourceGroupName,
      emailServiceName,
    });
  });

const program = (props: {
  dataLocation?: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const email = yield* Azure.Communication.EmailService("Email", {
      resourceGroup: group.resourceGroupName,
      dataLocation: props.dataLocation,
      tags: props.tags,
    });
    return { group, email };
  });

// Email services are free; ~1 minute.
test.provider(
  "create, update, replace, and delete an email service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, email } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      const rg = group.resourceGroupName;
      expect(email.dataLocation).toEqual("United States");
      expect(email.location.toLowerCase()).toEqual("global");
      const observed = yield* getEmailService(rg, email.emailServiceName);
      expect(observed.tags?.env).toEqual("test");

      // In-place: tags.
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.email.emailServiceId).toEqual(email.emailServiceId);
      expect(updated.email.tags).toEqual({ env: "prod" });
      const reobserved = yield* getEmailService(rg, email.emailServiceName);
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: the data location is immutable.
      const replaced = yield* stack.deploy(
        program({ dataLocation: "Europe", tags: { env: "prod" } }),
      );
      expect(replaced.email.emailServiceName).not.toEqual(
        email.emailServiceName,
      );
      const replacedObserved = yield* getEmailService(
        rg,
        replaced.email.emailServiceName,
      );
      expect(replacedObserved.properties?.dataLocation).toEqual("Europe");
      expect(
        yield* waitGone(getEmailService(rg, email.emailServiceName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(getEmailService(rg, replaced.email.emailServiceName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
