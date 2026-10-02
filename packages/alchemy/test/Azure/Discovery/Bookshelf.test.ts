import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as discovery from "@distilled.cloud/azure/discovery";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  location,
  logLevel,
  probeGroup,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getBookshelf = (resourceGroupName: string, bookshelfName: string) =>
  Effect.gen(function* () {
    return yield* discovery.GetBookshelve({
      subscriptionId: yield* subscription,
      resourceGroupName,
      bookshelfName,
    });
  });

const program = (props: {
  location: string;
  publicNetworkAccess: "Enabled" | "Disabled";
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity(
      "Workload",
      { resourceGroup: group.resourceGroupName, location },
    );
    const bookshelf = yield* Azure.Discovery.Bookshelf("Bookshelf", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      workloadIdentities: [identity.identityId],
      publicNetworkAccess: props.publicNetworkAccess,
    });
    return { group, bookshelf };
  });

// Microsoft Discovery is a gated preview: ARM does not expose its resource
// types to the trial subscription (InvalidResourceType, see the probe).
// A bookshelf provisions a managed resource group with AI Search and
// storage: roughly $1-3 and 20-40 minutes per run (two bookshelves across
// the replacement); runs only with AZURE_TEST_PAID=1.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete a discovery bookshelf",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, bookshelf } = yield* stack.deploy(
        program({ location, publicNetworkAccess: "Disabled" }),
      );
      const get = (name: string) => getBookshelf(group.resourceGroupName, name);
      const observed = yield* get(bookshelf.bookshelfName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.publicNetworkAccess).toEqual("Disabled");

      // In place: public network access.
      const updated = yield* stack.deploy(
        program({ location, publicNetworkAccess: "Enabled" }),
      );
      expect(updated.bookshelf.bookshelfId).toEqual(bookshelf.bookshelfId);
      expect(
        (yield* get(bookshelf.bookshelfName)).properties?.publicNetworkAccess,
      ).toEqual("Enabled");

      // A location change replaces the bookshelf.
      const replaced = yield* stack.deploy(
        program({ location: "eastus2", publicNetworkAccess: "Enabled" }),
      );
      expect(replaced.bookshelf.bookshelfName).not.toEqual(
        bookshelf.bookshelfName,
      );
      expect(yield* waitGone(get(bookshelf.bookshelfName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.bookshelf.bookshelfName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

test.provider(
  "discovery bookshelves are rejected where the preview is not enabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(probeGroup);
      const error = yield* discovery
        .BookshelvesCreateOrUpdate({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          bookshelfName: "alchemy-probe",
          location,
          properties: {},
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("InvalidResourceType");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);
