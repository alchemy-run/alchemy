import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as sns from "@distilled.cloud/aws/sns";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "probe SMS-plane distilled ops",
  (_stack) =>
    Effect.gen(function* () {
      const ops: Array<[string, Effect.Effect<unknown, unknown>]> = [
        ["getSMSAttributes", sns.getSMSAttributes({}) as any],
        [
          "checkIfPhoneNumberIsOptedOut",
          sns.checkIfPhoneNumberIsOptedOut({
            phoneNumber: "+15555550100",
          }) as any,
        ],
        ["listPhoneNumbersOptedOut", sns.listPhoneNumbersOptedOut({}) as any],
        ["listOriginationNumbers", sns.listOriginationNumbers({}) as any],
        [
          "getSMSSandboxAccountStatus",
          sns.getSMSSandboxAccountStatus({}) as any,
        ],
        [
          "listSMSSandboxPhoneNumbers",
          sns.listSMSSandboxPhoneNumbers({}) as any,
        ],
        ["listPlatformApplications", sns.listPlatformApplications({}) as any],
        [
          "setSMSAttributes",
          sns.setSMSAttributes({
            attributes: { DefaultSMSType: "Transactional" },
          }) as any,
        ],
      ];
      for (const [name, op] of ops) {
        const result = yield* Effect.result(op);
        if (Result.isFailure(result)) {
          console.log(`${name} FAILED:`, result.failure);
        } else {
          console.log(
            `${name} OK:`,
            JSON.stringify(result.success).slice(0, 200),
          );
        }
      }
      expect(true).toBe(true);
    }),
  { timeout: 60_000 },
);
