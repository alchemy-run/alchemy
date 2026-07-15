import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as avp from "@distilled.cloud/aws/verifiedpermissions";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "probe alias name format + identity source create",
  (_stack) =>
    Effect.gen(function* () {
      const store = yield* avp.createPolicyStore({
        validationSettings: { mode: "OFF" },
        description: "alias probe",
      });
      console.log("store", store.policyStoreId);
      const names = [
        "alchemy-probe-alias",
        "alchemyprobealias",
        "alchemy_probe_alias",
        "policystorealiasteststack-alias-testing-b5jtimvhblpnyriu",
      ];
      for (const aliasName of names) {
        const r = yield* Effect.result(
          avp.createPolicyStoreAlias({
            aliasName,
            policyStoreId: store.policyStoreId,
          }),
        );
        if (Result.isSuccess(r)) {
          console.log("OK   ", aliasName);
          yield* Effect.result(
            avp.deletePolicyStoreAlias({
              aliasName,
              deletionMode: "HardDelete",
            }),
          );
        } else {
          const e = r.failure as {
            _tag: string;
            message?: string;
            fieldList?: unknown;
          };
          console.log(
            "FAIL ",
            aliasName,
            e._tag,
            e.message,
            JSON.stringify(e.fieldList ?? ""),
          );
        }
      }
      // identity source immediately after a fresh store (EC probe)
      const store2 = yield* avp.createPolicyStore({
        validationSettings: { mode: "OFF" },
        description: "idsource probe",
      });
      const is = yield* Effect.result(
        avp.createIdentitySource({
          policyStoreId: store2.policyStoreId,
          principalEntityType: "PhotoApp::User",
          configuration: {
            openIdConnectConfiguration: {
              issuer: "https://accounts.google.com",
              tokenSelection: {
                identityTokenOnly: { clientIds: ["alchemy-test-client"] },
              },
            },
          },
        }),
      );
      if (Result.isSuccess(is)) {
        console.log("IDSOURCE OK", is.success.identitySourceId);
      } else {
        const e = is.failure as {
          _tag: string;
          message?: string;
          fieldList?: unknown;
        };
        console.log(
          "IDSOURCE FAIL",
          e._tag,
          e.message,
          JSON.stringify(e.fieldList ?? ""),
        );
      }
      yield* Effect.result(
        avp.deletePolicyStore({ policyStoreId: store.policyStoreId }),
      );
      yield* Effect.result(
        avp.deletePolicyStore({ policyStoreId: store2.policyStoreId }),
      );
    }),
  { timeout: 120_000 },
);
