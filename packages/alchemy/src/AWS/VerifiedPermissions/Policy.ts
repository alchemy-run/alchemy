import * as avp from "@distilled.cloud/aws/verifiedpermissions";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface PolicyProps {
  /**
   * The ID of the policy store the policy belongs to. Changing the store
   * replaces the policy.
   */
  policyStoreId: string;
  /**
   * The Cedar policy statement, e.g.
   * `permit(principal, action == Action::"view", resource);`. Mutable —
   * updating re-submits the statement via `UpdatePolicy`.
   */
  statement: string;
  /**
   * An optional description stored alongside the policy statement.
   */
  description?: string;
}

export interface Policy extends Resource<
  "AWS.VerifiedPermissions.Policy",
  PolicyProps,
  {
    /**
     * ID of the policy store the policy belongs to.
     */
    policyStoreId: string;
    /**
     * Service-assigned unique ID of the policy within the store.
     */
    policyId: string;
  },
  {},
  Providers
> {}

/**
 * A static Cedar policy in a Verified Permissions policy store. Static
 * policies contain a complete Cedar statement and are evaluated for every
 * matching authorization request.
 * @resource
 * @section Creating Policies
 * @example Permit a Specific Principal
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const store = yield* AWS.VerifiedPermissions.PolicyStore("Store", {});
 *
 * yield* AWS.VerifiedPermissions.Policy("AllowAlice", {
 *   policyStoreId: store.policyStoreId,
 *   statement: `permit(
 *     principal == PhotoApp::User::"alice",
 *     action == PhotoApp::Action::"viewPhoto",
 *     resource
 *   );`,
 *   description: "Alice can view any photo",
 * });
 * ```
 */
export const Policy = Resource<Policy>("AWS.VerifiedPermissions.Policy");

export const PolicyProvider = () =>
  Provider.effect(
    Policy,
    Effect.gen(function* () {
      const observe = Effect.fn(function* (
        policyStoreId: string,
        policyId: string,
      ) {
        return yield* avp
          .getPolicy({ policyStoreId, policyId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return Policy.Provider.of({
        stables: ["policyStoreId", "policyId"],

        // child of a policy store — not enumerable account-wide
        list: () => Effect.succeed([]),

        read: Effect.fn(function* ({ olds, output }) {
          const policyStoreId = output?.policyStoreId ?? olds?.policyStoreId;
          const policyId = output?.policyId;
          if (policyStoreId === undefined || policyId === undefined) {
            return undefined;
          }
          const policy = yield* observe(policyStoreId, policyId);
          if (policy === undefined) return undefined;
          return { policyStoreId, policyId: policy.policyId };
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (olds.policyStoreId !== news.policyStoreId) {
            return { action: "replace" } as const;
          }
          // statement / description are mutable → default update path
        }),

        reconcile: Effect.fn(function* ({ news, output, session }) {
          const definition = {
            static: {
              statement: news.statement,
              description: news.description,
            },
          };

          // 1. OBSERVE — cloud state is authoritative
          const existing =
            output?.policyId !== undefined
              ? yield* observe(news.policyStoreId, output.policyId)
              : undefined;

          // 2. ENSURE / SYNC
          let policyId: string;
          if (existing === undefined) {
            const created = yield* avp.createPolicy({
              policyStoreId: news.policyStoreId,
              definition,
            });
            policyId = created.policyId;
          } else {
            const updated = yield* avp.updatePolicy({
              policyStoreId: news.policyStoreId,
              policyId: existing.policyId,
              definition: {
                static: {
                  statement: news.statement,
                  description: news.description,
                },
              },
            });
            policyId = updated.policyId;
          }

          yield* session.note(policyId);
          return { policyStoreId: news.policyStoreId, policyId };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* avp
            .deletePolicy({
              policyStoreId: output.policyStoreId,
              policyId: output.policyId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
