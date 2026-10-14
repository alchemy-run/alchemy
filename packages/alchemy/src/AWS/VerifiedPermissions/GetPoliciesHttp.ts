import * as AVP from "@distilled.cloud/aws/verifiedpermissions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HostAccess from "../HostAccess.ts";
import { GetPolicies, type GetPoliciesRequest } from "./GetPolicies.ts";
import type { PolicyStore } from "./PolicyStore.ts";

export const GetPoliciesHttp = Layer.effect(
  GetPolicies,
  Effect.gen(function* () {
    const batchGetPolicy = yield* HostAccess.withCredentials(AVP.batchGetPolicy);

    return Effect.fn(function* <S extends PolicyStore>(store: S) {
      const PolicyStoreId = yield* store.policyStoreId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* HostAccess.bind`AWS.VerifiedPermissions.GetPolicies(${store})`({
          policyStatements: [
            {
              Effect: "Allow",
              // BatchGetPolicy authorizes under verifiedpermissions:GetPolicy
              Action: ["verifiedpermissions:GetPolicy", "verifiedpermissions:BatchGetPolicy"],
              Resource: [store.policyStoreArn],
            },
          ],
        });
      }
      const label = store.LogicalId;
      return {
        batchGetPolicy: Effect.fn(`AWS.VerifiedPermissions.BatchGetPolicy(${label})`)(function* (
          request: GetPoliciesRequest,
        ) {
          const policyStoreId = yield* PolicyStoreId;
          return yield* batchGetPolicy({
            requests: request.policyIds.map((policyId) => ({
              policyStoreId,
              policyId,
            })),
          });
        }),
      };
    });
  }),
);
