import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cdn from "@distilled.cloud/azure/cdn";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  FRONT_DOOR_TIMEOUT,
  logLevel,
  profileStack,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getEndpoint = (
  resourceGroupName: string,
  profileName: string,
  endpointName: string,
) =>
  Effect.gen(function* () {
    return yield* cdn.GetAFDEndpoint({
      subscriptionId: yield* subscription,
      resourceGroupName,
      profileName,
      endpointName,
    });
  });

const program = (props: {
  name?: string;
  enabledState: "Enabled" | "Disabled";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, profile } = yield* profileStack;
    const endpoint = yield* Azure.Cdn.AfdEndpoint("Web", {
      resourceGroup: group.resourceGroupName,
      profile: profile.profileName,
      name: props.name,
      enabledState: props.enabledState,
      tags: props.tags,
    });
    return { group, profile, endpoint };
  });

// Front Door Standard profile (~$0.05/hour, <$0.10 per run, 10-20 minutes
// with the profile delete). Free Trial subscriptions cannot create Front
// Door profiles (see the probe in Profile.test.ts).
test.provider.skipIf(!runPaidOnly)(
  "endpoint lifecycle",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, profile, endpoint } = yield* stack.deploy(
        program({ enabledState: "Enabled", tags: { env: "test" } }),
      );
      const get = (name: string) =>
        getEndpoint(group.resourceGroupName, profile.profileName, name);
      expect(endpoint.hostName).toContain(".azurefd.net");
      const observed = yield* get(endpoint.endpointName);
      expect(observed.properties?.enabledState).toEqual("Enabled");
      expect(observed.tags?.env).toEqual("test");

      // In place: disable and retag.
      const updated = yield* stack.deploy(
        program({ enabledState: "Disabled", tags: { env: "prod" } }),
      );
      expect(updated.endpoint.endpointId).toEqual(endpoint.endpointId);
      const reobserved = yield* get(endpoint.endpointName);
      expect(reobserved.properties?.enabledState).toEqual("Disabled");
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: a new name.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-cdn-web-renamed",
          enabledState: "Disabled",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.endpoint.endpointName).toEqual("alchemy-cdn-web-renamed");
      expect(yield* waitGone(get(endpoint.endpointName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.endpoint.endpointName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: FRONT_DOOR_TIMEOUT },
);
