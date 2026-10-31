import * as Rivet from "@alchemy.run/rivet";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Rivet.providers() });

// Needs a Rivet Cloud namespace: set RIVET_ENDPOINT, RIVET_NAMESPACE and
// RIVET_TOKEN (the namespace's token from the Rivet dashboard) in the testing
// profile, then implement this as the AWS suite on RivetCloud.ControlPlane.
test.todo(
  "RivetCloud.ControlPlane: conformance on a Rivet Cloud namespace (needs a Rivet Cloud token)",
  Effect.void,
);
