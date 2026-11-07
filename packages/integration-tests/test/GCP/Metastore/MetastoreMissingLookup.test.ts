import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:metastore", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-federation": GCP.Metastore.Federation.lookup({ federationId: name }).name,
        "missing-service": GCP.Metastore.Service.lookup({ serviceId: name }).name,
        "missing-services-backup": GCP.Metastore.ServicesBackup.lookup({
          backupId: name,
          service: name,
        }).name,
      });
    }),
  { tags, timeout: 105000 },
);
