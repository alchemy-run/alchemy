import * as AWS from "@/AWS";
import { TrustedServiceAccess } from "@/AWS/Organizations";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Read-only `list()` test (AWS account-scoped collection that enumerates every
// service principal granted trusted access to the organization). Resolve the
// provider from context via the typed `Provider.findProvider`, call `list()`,
// and assert the result is a well-typed `Attributes[]`.
//
// `list()` is designed to degrade gracefully off the org management account:
// `listAWSServiceAccessForOrganization` rejects with
// `AWSOrganizationsNotInUseException` / `AccessDeniedException` when the caller
// isn't an org management/delegated account, which `list()` catches and maps to
// `[]`. So this case passes on any account — it just returns `[]` when the
// account can't enumerate trusted service access.
test.provider("list enumerates trusted service access", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(TrustedServiceAccess);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);

    for (const item of all) {
      expect(typeof item.servicePrincipal).toBe("string");
      if (item.dateEnabled !== undefined) {
        expect(item.dateEnabled).toBeInstanceOf(Date);
      }
    }
  }),
);

// Full lifecycle list test — requires an org MANAGEMENT account. Gate behind an
// env var so an entitled account runs it unchanged. Off a management account
// `enableAWSServiceAccess` rejects with `AWSOrganizationsNotInUseException` /
// `AccessDeniedException`, so this is skipped by default.
const servicePrincipal =
  process.env.AWS_ORG_TRUSTED_SERVICE_PRINCIPAL ?? "config.amazonaws.com";

test.provider.skipIf(!process.env.AWS_ORG_MANAGEMENT_ACCOUNT)(
  "list contains the deployed trusted service access",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* TrustedServiceAccess("ListTrustedServiceAccess", {
            servicePrincipal,
          });
        }),
      );

      const provider = yield* Provider.findProvider(TrustedServiceAccess);
      const all = yield* provider.list();

      expect(
        all.some((item) => item.servicePrincipal === access.servicePrincipal),
      ).toBe(true);

      yield* stack.destroy();
    }),
);
