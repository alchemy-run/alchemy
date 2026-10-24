import * as Azure from "@alchemy.run/azure";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { basicV2Service, logLevel, subscriptionId, tags, untilGone } from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getContentType = (resourceGroupName: string, serviceName: string, contentTypeId: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetContentType({ subscriptionId, resourceGroupName, serviceName, contentTypeId }),
  );

const schema = (fields: string[]) => ({
  type: "object",
  properties: Object.fromEntries(fields.map((field) => [field, { type: "string" }])),
});

const program = (contentType?: { name: string; displayName: string; fields: string[] }) =>
  Effect.gen(function* () {
    const { group, service } = yield* basicV2Service;
    const created = contentType
      ? yield* Azure.ApiManagement.ContentType("Faq", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          name: contentType.name,
          displayName: contentType.displayName,
          description: "Questions and answers",
          schema: schema(contentType.fields),
        })
      : undefined;
    return { group, service, contentType: created };
  });

// Content types belong to the developer portal, which Consumption lacks.
// A BasicV2 service bills ~$0.21/h and takes 5-15+ minutes to create:
// est. ~$0.10 and ~25 minutes per run.
test.provider.skipIf(!runExpensive)(
  "create, update, replace, and delete a content type",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({ name: "c-alchemy-faq", displayName: "FAQ", fields: ["question"] }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.contentType?.contentTypeName).toEqual("c-alchemy-faq");
      const observed = yield* getContentType(rg, svc, "c-alchemy-faq");
      expect(observed.properties?.name).toEqual("FAQ");
      expect(observed.properties?.description).toEqual("Questions and answers");

      // In-place update of the display name and the schema.
      yield* stack.deploy(
        program({
          name: "c-alchemy-faq",
          displayName: "FAQ entry",
          fields: ["question", "answer"],
        }),
      );
      const updated = yield* getContentType(rg, svc, "c-alchemy-faq");
      expect(updated.properties?.name).toEqual("FAQ entry");
      expect(updated.properties?.schema).toMatchObject(schema(["question", "answer"]));

      // Replacement: a new identifier creates a new content type, deletes the old.
      const replaced = yield* stack.deploy(
        program({ name: "c-alchemy-faq-v2", displayName: "FAQ v2", fields: ["question"] }),
      );
      expect(replaced.contentType?.contentTypeName).toEqual("c-alchemy-faq-v2");
      expect(yield* untilGone(getContentType(rg, svc, "c-alchemy-faq"))).toEqual("gone");

      // Removing the resource deletes the content type.
      yield* stack.deploy(program());
      expect(yield* untilGone(getContentType(rg, svc, "c-alchemy-faq-v2"))).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 1_800_000 },
);
