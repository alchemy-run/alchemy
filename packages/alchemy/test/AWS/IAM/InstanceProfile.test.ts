import * as AWS from "@/AWS";
import { InstanceProfile } from "@/AWS/IAM";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Canonical `list()` test (IAM is global; account-scoped collection): deploy a
// real instance profile, resolve the typed provider from context via
// `findProvider`, call `list()`, and assert the deployed profile appears in the
// exhaustively-paginated result.
test.provider("list enumerates the deployed instance profile", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const profile = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* InstanceProfile("ListProfile", {
          instanceProfileName: "alchemy-test-instance-profile-list",
        });
      }),
    );

    const provider = yield* Provider.findProvider(InstanceProfile);
    const all = yield* provider.list();

    expect(
      all.some((p) => p.instanceProfileName === profile.instanceProfileName),
    ).toBe(true);

    yield* stack.destroy();
  }),
);
