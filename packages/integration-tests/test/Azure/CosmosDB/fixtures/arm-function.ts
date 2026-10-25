import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { accepted } from "../../arm-action-fixture.ts";
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";

/** Write region at deploy; the failover-priority route moves the write region to {@link SECOND}. */
export const FIRST = "centralus";
export const SECOND = "westus3";

/** A two-region account with no databases (an empty account bills nothing). */
export const Account = Azure.CosmosDB.DatabaseAccount("CosmosArmBindingsAccount", {
  location: FIRST,
  locations: [
    { locationName: FIRST, failoverPriority: 0 },
    { locationName: SECOND, failoverPriority: 1 },
  ],
});

/**
 * Effect-native Azure Function exercising the Cosmos DB account
 * runtime-action binding on a managed-identity host.
 */
export default class CosmosArmFunction extends Azure.Functions.Function<CosmosArmFunction>()(
  "CosmosArmFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const account = yield* Account;
    const changeFailoverPriority = yield* Azure.CosmosDB.ChangeFailoverPriority(account);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        switch (new URL(request.url, "http://localhost").pathname) {
          case "/promote-second":
            return yield* accepted(
              changeFailoverPriority({
                failoverPolicies: [
                  { locationName: SECOND, failoverPriority: 0 },
                  { locationName: FIRST, failoverPriority: 1 },
                ],
              }),
            );
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(Effect.provide(Azure.CosmosDB.ChangeFailoverPriorityHttp)),
) {}
