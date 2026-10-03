import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { runExpensive } from "../gates.ts";
import { basicV2Service, logLevel, subscriptionId, tags } from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getTemplate = (resourceGroupName: string, serviceName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetEmailTemplate({
      subscriptionId,
      resourceGroupName,
      serviceName,
      templateName: "applicationApprovedNotificationMessage",
    }),
  );

const body = (text: string) =>
  `<!DOCTYPE html><html><body><p>${text}</p></body></html>`;

const program = (subject?: string) =>
  Effect.gen(function* () {
    const { group, service } = yield* basicV2Service;
    const template =
      subject === undefined
        ? undefined
        : yield* Azure.ApiManagement.EmailTemplate("Approved", {
            resourceGroup: group.resourceGroupName,
            serviceName: service.serviceName,
            templateName: "applicationApprovedNotificationMessage",
            subject,
            body: body(subject),
          });
    return { group, service, template };
  });

// Email templates are not available on Consumption ("Method not allowed
// in Consumption pricing tier"). A BasicV2 service bills ~$0.21/h and
// takes 5-15+ minutes to create: est. ~$0.10 and ~25 minutes per run.
test.provider.skipIf(!runExpensive)(
  "customize, update, and reset an email template",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program("Welcome aboard"));
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.template?.subject).toEqual("Welcome aboard");
      const observed = yield* getTemplate(rg, svc);
      expect(observed.properties?.subject).toEqual("Welcome aboard");
      expect(observed.properties?.isDefault).toEqual(false);

      // In-place update of the subject and body.
      yield* stack.deploy(program("Your subscription is ready"));
      expect((yield* getTemplate(rg, svc)).properties?.subject).toEqual(
        "Your subscription is ready",
      );

      // Removing the resource resets the template to its default.
      yield* stack.deploy(program());
      const reset = yield* getTemplate(rg, svc).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (template) => template.properties?.isDefault === true,
          times: 10,
        }),
      );
      expect(reset.properties?.isDefault).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
