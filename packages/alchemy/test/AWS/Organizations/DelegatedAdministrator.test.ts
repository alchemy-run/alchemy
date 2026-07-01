import * as AWS from "@/AWS";
import { DelegatedAdministrator } from "@/AWS/Organizations";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Read-only `list()` test (AWS account/region-scoped collection with a
// per-account service fan-out). Resolve the provider from context via the
// typed `Provider.findProvider`, call `list()`, and assert the result is a
// well-typed `Attributes[]`.
//
// `list()` is designed to degrade gracefully off the org management account:
// `listDelegatedAdministrators` rejects with `AWSOrganizationsNotInUseException`
// / `AccessDeniedException` / `UnsupportedAPIEndpointException` when the caller
// isn't an org management/delegated account, which `list()` catches and maps to
// `[]`. So this case passes on any account — it just returns `[]` when the
// account can't enumerate delegated administrators.
test.provider("list enumerates delegated administrators", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(DelegatedAdministrator);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);

    for (const item of all) {
      expect(typeof item.accountId).toBe("string");
      expect(typeof item.servicePrincipal).toBe("string");
    }
  }),
);

// Full lifecycle list test — requires an org MANAGEMENT account plus a member
// account to register as a delegated administrator. Gate behind env vars so an
// entitled account runs it unchanged. Off a management account
// `registerDelegatedAdministrator` rejects with
// `AWSOrganizationsNotInUseException` / `AccessDeniedException`, so this is
// skipped by default.
const memberAccountId = process.env.AWS_ORG_DELEGATED_ADMIN_ACCOUNT_ID;
const servicePrincipal =
  process.env.AWS_ORG_DELEGATED_ADMIN_SERVICE_PRINCIPAL ??
  "config.amazonaws.com";

test.provider.skipIf(!memberAccountId)(
  "list contains the deployed delegated administrator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const admin = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DelegatedAdministrator("ListDelegatedAdmin", {
            accountId: memberAccountId!,
            servicePrincipal,
          });
        }),
      );

      const provider = yield* Provider.findProvider(DelegatedAdministrator);
      const all = yield* provider.list();

      expect(
        all.some(
          (item) =>
            item.accountId === admin.accountId &&
            item.servicePrincipal === admin.servicePrincipal,
        ),
      ).toBe(true);

      yield* stack.destroy();
    }),
);
