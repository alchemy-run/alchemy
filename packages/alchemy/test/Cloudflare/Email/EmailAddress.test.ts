import * as Cloudflare from "@/Cloudflare";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// A deterministic destination address used for the list test. Cloudflare
// sends a verification email on first create; the address still shows up in
// the account-scoped list whether or not it has been verified, which is all
// the list() assertion needs.
const testEmail = "alchemy-list-test@alchemy-test-2.us";

// Canonical `list()` test (account-scoped collection): register a real
// destination address, resolve the provider from context via the typed
// `findProvider`, call `list()`, and assert the deployed address appears in
// the exhaustively-paginated result.
test.provider("list enumerates the deployed email address", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const address = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.EmailAddress("ListAddress", {
          email: testEmail,
        });
      }),
    );

    expect(address.email).toEqual(testEmail);

    const provider = yield* Provider.findProvider(Cloudflare.EmailAddress);
    const all = yield* provider.list();

    expect(all.some((a) => a.addressId === address.addressId)).toBe(true);
    expect(all.some((a) => a.email === testEmail)).toBe(true);

    yield* stack.destroy();
  }).pipe(logLevel),
);
