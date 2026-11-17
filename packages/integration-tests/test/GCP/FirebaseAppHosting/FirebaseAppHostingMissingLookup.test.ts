import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:firebaseapphosting", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-backend": GCP.FirebaseAppHosting.Backend.lookup({ backendId: name }).name,
        "missing-backends-build": GCP.FirebaseAppHosting.BackendsBuild.lookup({
          buildId: name,
          backend: name,
        }).name,
        "missing-backends-domain": GCP.FirebaseAppHosting.BackendsDomain.lookup({
          domainId: name,
          backend: name,
        }).name,
      });
    }),
  { tags, timeout: 105000 },
);
