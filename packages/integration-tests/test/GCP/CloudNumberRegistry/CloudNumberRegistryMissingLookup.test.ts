import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:cloudnumberregistry", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-custom-range": GCP.CloudNumberRegistry.CustomRange.lookup({ customRangeId: name })
          .name,
        "missing-ipam-admin-scope": GCP.CloudNumberRegistry.IpamAdminScope.lookup({
          ipamAdminScopeId: name,
        }).name,
        "missing-realm": GCP.CloudNumberRegistry.Realm.lookup({ realmId: name }).name,
        "missing-registry-book": GCP.CloudNumberRegistry.RegistryBook.lookup({
          registryBookId: name,
        }).name,
      });
    }),
  { tags, timeout: 120000 },
);
