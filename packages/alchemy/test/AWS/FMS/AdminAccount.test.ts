import * as AWS from "@/AWS";
import { AdminAccount } from "@/AWS/FMS/AdminAccount.ts";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import * as Test from "@/Test/Vitest";
import * as fms from "@distilled.cloud/aws/fms";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: on an account that is not the AWS Firewall Manager
// admin, `getAdminAccount` must surface as a typed `ResourceNotFoundException`
// from distilled's `GetAdminAccountError` union. This proves the SDK's typed
// error mapping at near-zero cost and never mutates the organization. The full
// live lifecycle (which requires the Organizations management account) is gated
// behind AWS_TEST_FMS=1 below.
test.provider(
  "getAdminAccount on a non-admin account returns a typed ResourceNotFoundException",
  (_stack) =>
    Effect.gen(function* () {
      const existing = yield* fms.getAdminAccount({}).pipe(
        Effect.map((r) => r as fms.GetAdminAccountResponse | undefined),
        Effect.catchTag("ResourceNotFoundException", () =>
          Effect.succeed(undefined),
        ),
      );
      if (existing?.AdminAccount) {
        yield* Effect.logInfo(
          `FMS admin already configured (${existing.AdminAccount}) — probe skipped`,
        );
        return;
      }

      const result = yield* Effect.result(fms.getAdminAccount({}));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("ResourceNotFoundException");
      }
    }),
  { timeout: 60_000 },
);

// Full live lifecycle. FMS requires the caller to be the AWS Organizations
// management account with AWS Config enabled org-wide. Gated so an entitled
// account can run it unchanged: AWS_TEST_FMS=1.
test.provider.skipIf(!process.env.AWS_TEST_FMS)(
  "lifecycle: designate the FMS admin account, then disassociate",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* AWSEnvironment.current;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AdminAccount("FmsAdmin", {});
        }),
      );
      expect(created.adminAccount).toBe(accountId);

      const live = yield* fms.getAdminAccount({});
      expect(live.AdminAccount).toBe(accountId);

      yield* stack.destroy();
      const after = yield* fms.getAdminAccount({}).pipe(
        Effect.map((r) => r.AdminAccount),
        Effect.catchTag("ResourceNotFoundException", () =>
          Effect.succeed(undefined),
        ),
      );
      expect(after).toBeUndefined();
    }),
  { timeout: 240_000 },
);
