import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cdn from "@distilled.cloud/azure/cdn";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  FRONT_DOOR_TIMEOUT,
  logLevel,
  originStack,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRoute = (
  resourceGroupName: string,
  profileName: string,
  endpointName: string,
  routeName: string,
) =>
  Effect.gen(function* () {
    return yield* cdn.GetRoute({
      subscriptionId: yield* subscription,
      resourceGroupName,
      profileName,
      endpointName,
      routeName,
    });
  });

const program = (props: {
  name?: string;
  httpsRedirect: "Enabled" | "Disabled";
  patternsToMatch: string[];
}) =>
  Effect.gen(function* () {
    const { group, profile, originGroup, origin } = yield* originStack;
    const endpoint = yield* Azure.Cdn.AfdEndpoint("Web", {
      resourceGroup: group.resourceGroupName,
      profile: profile.profileName,
    });
    const route = yield* Azure.Cdn.Route("Default", {
      resourceGroup: group.resourceGroupName,
      profile: profile.profileName,
      endpoint: endpoint.endpointName,
      name: props.name,
      originGroupId: originGroup.originGroupId,
      httpsRedirect: props.httpsRedirect,
      patternsToMatch: props.patternsToMatch,
      forwardingProtocol: "HttpsOnly",
    });
    return { group, profile, endpoint, origin, route };
  });

// Front Door Standard profile (<$0.10 per run, 10-20 minutes with the profile
// delete). Free Trial subscriptions cannot create Front Door profiles.
test.provider.skipIf(!runPaidOnly)(
  "route lifecycle",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, profile, endpoint, route } = yield* stack.deploy(
        program({ httpsRedirect: "Enabled", patternsToMatch: ["/*"] }),
      );
      const get = (name: string) =>
        getRoute(
          group.resourceGroupName,
          profile.profileName,
          endpoint.endpointName,
          name,
        );
      const observed = yield* get(route.routeName);
      expect(observed.properties?.httpsRedirect).toEqual("Enabled");
      expect(observed.properties?.forwardingProtocol).toEqual("HttpsOnly");

      // In place: redirect and patterns.
      const updated = yield* stack.deploy(
        program({
          httpsRedirect: "Disabled",
          patternsToMatch: ["/*", "/api/*"],
        }),
      );
      expect(updated.route.routeId).toEqual(route.routeId);
      const reobserved = yield* get(route.routeName);
      expect(reobserved.properties?.httpsRedirect).toEqual("Disabled");
      expect(reobserved.properties?.patternsToMatch).toEqual(["/*", "/api/*"]);

      // Replacement: a new name.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-route-renamed",
          httpsRedirect: "Disabled",
          patternsToMatch: ["/*", "/api/*"],
        }),
      );
      expect(replaced.route.routeName).toEqual("alchemy-route-renamed");
      expect(yield* waitGone(get(route.routeName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.route.routeName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: FRONT_DOOR_TIMEOUT },
);
