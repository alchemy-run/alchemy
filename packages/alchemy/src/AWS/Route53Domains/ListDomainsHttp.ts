import * as route53domains from "@distilled.cloud/aws/route-53-domains";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { ListDomains, type ListDomainsRequest } from "./ListDomains.ts";
import { withRoute53DomainsRegion } from "./internal.ts";

export const ListDomainsHttp = Layer.effect(
  ListDomains,
  Effect.gen(function* () {
    // Capture the client with the region pinned to us-east-1 — the Route 53
    // Domains API is not served from any other region.
    const listDomains = yield* withRoute53DomainsRegion(
      route53domains.listDomains,
    );

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Route53Domains.ListDomains())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["route53domains:ListDomains"],
                // route53domains has no resource-level IAM
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn("AWS.Route53Domains.ListDomains")(function* (
        request: ListDomainsRequest,
      ) {
        return yield* listDomains(request);
      });
    });
  }),
);
