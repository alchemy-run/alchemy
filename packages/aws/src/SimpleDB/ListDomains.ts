import * as sdb from "@distilled.cloud/aws/simpledb";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";

/**
 * Runtime binding for `sdb:ListDomains`.
 *
 * Account-level operation — invoked with no resource argument. Lists the
 * domain names in the current region, one page (up to 100 names) per call;
 * pass the response's `NextToken` back to continue. Useful for the classic
 * SimpleDB domain-sharding pattern where an application spreads items across
 * many domains and discovers them at runtime. Provide the implementation
 * with `Effect.provide(AWS.SimpleDB.ListDomainsHttp)`.
 * ### Domain Introspection
 * **Example:** List Domain Names
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listDomains = yield* AWS.SimpleDB.ListDomains();
 *
 * // runtime
 * const page = yield* listDomains({ MaxNumberOfDomains: 100 });
 * // page.DomainNames: ["users-shard-0", "users-shard-1", ...]
 * ```
 *
 * @binding
 */
export interface ListDomains extends Binding.Service<
  ListDomains,
  "AWS.SimpleDB.ListDomains",
  () => Effect.Effect<
    (
      request?: sdb.ListDomainsRequest,
    ) => Effect.Effect<sdb.ListDomainsResponse, sdb.ListDomainsError, RuntimeContext>
  >
> {}
export const ListDomains = Binding.Service<ListDomains>("AWS.SimpleDB.ListDomains");

/**
 * Account-level binding — bespoke rather than `makeSimpleDbBinding` because
 * `ListDomains` targets no single domain: SimpleDB IAM cannot scope it
 * narrower than every domain in the account, so the grant is
 * `sdb:ListDomains` on `domain/*` (expressed as `*`).
 */
export const ListDomainsHttp = Layer.effect(
  ListDomains,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const listDomains = yield* AWSBindings.withCredentials(sdb.listDomains);

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.SimpleDB.ListDomains()`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["sdb:ListDomains"],
              Resource: ["*"],
            },
          ],
        });
      }
      return Effect.fn("AWS.SimpleDB.ListDomains")(function* (request?: sdb.ListDomainsRequest) {
        return yield* listDomains({ ...request });
      });
    });
  }),
);
