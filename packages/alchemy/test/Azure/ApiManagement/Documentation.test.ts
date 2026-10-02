import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import {
  basicV2Service,
  logLevel,
  subscriptionId,
  tags,
  untilGone,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getDoc = (
  resourceGroupName: string,
  serviceName: string,
  documentationId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetDocumentation({
      subscriptionId,
      resourceGroupName,
      serviceName,
      documentationId,
    }),
  );

const program = (doc?: { name: string; content: string }) =>
  Effect.gen(function* () {
    const { group, service } = yield* basicV2Service;
    const created = doc
      ? yield* Azure.ApiManagement.Documentation("Guide", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          name: doc.name,
          title: "Getting started",
          content: doc.content,
        })
      : undefined;
    return { group, service, doc: created };
  });

// Documentation pages are not available on Consumption (PUT returns an
// empty 404). A BasicV2 service bills ~$0.21/h and takes 5-15+ minutes to
// create: est. ~$0.10 and ~25 minutes per run.
test.provider.skipIf(!runExpensive)(
  "create, update, replace, and delete a documentation page",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({ name: "alchemy-guide", content: "# One" }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.doc?.documentationName).toEqual("alchemy-guide");
      expect(
        (yield* getDoc(rg, svc, "alchemy-guide")).properties?.content,
      ).toEqual("# One");

      // In-place update of the content.
      yield* stack.deploy(program({ name: "alchemy-guide", content: "# Two" }));
      expect(
        (yield* getDoc(rg, svc, "alchemy-guide")).properties?.content,
      ).toEqual("# Two");

      // Replacement: a new identifier creates a new page.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-guide-v2", content: "# Two" }),
      );
      expect(replaced.doc?.documentationName).toEqual("alchemy-guide-v2");
      expect(yield* untilGone(getDoc(rg, svc, "alchemy-guide"))).toEqual(
        "gone",
      );

      // Removing the resource deletes the page.
      yield* stack.deploy(program());
      expect(yield* untilGone(getDoc(rg, svc, "alchemy-guide-v2"))).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
