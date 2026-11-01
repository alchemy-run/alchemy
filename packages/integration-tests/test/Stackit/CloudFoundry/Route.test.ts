import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as cf from "@distilled.cloud/stackit/cloud_foundry";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitTags } from "../helpers.ts";
import { asManager, CF_MEMORY_IN_MB, deployer, EXAMPLE_IMAGE, expectGone } from "./helpers.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("cloudfoundry", "route"), timeout: 1_500_000 } as const;

test.provider(
  "create, retarget and delete a route",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (args: { host: string | undefined; toApp: boolean }) =>
        Effect.gen(function* () {
          const target = yield* deployer("Route");
          const app = yield* Stackit.CloudFoundry.App("RouteApp", {
            spaceId: target.space.spaceId,
            credentials: target.credentials,
            image: EXAMPLE_IMAGE,
            memoryInMb: CF_MEMORY_IN_MB,
            noRoute: true,
          });
          const route = yield* Stackit.CloudFoundry.Route("Route", {
            spaceId: target.space.spaceId,
            credentials: target.credentials,
            host: args.host,
            appIds: args.toApp ? [app.appId] : [],
            labels: { env: "test" },
          });
          return { manager: target.manager, app, route };
        });

      const created = yield* stack.deploy(program({ host: undefined, toApp: true }));
      const login = created.manager;
      expect(created.route.url).toMatch(/^https:\/\//);
      expect(created.route.labels).toEqual({ env: "test" });

      // Out of band: the destination, and Alchemy's ownership labels.
      const observed = yield* cf.getRoute({ guid: created.route.routeId }).pipe(asManager(login));
      expect(observed.metadata?.labels?.["alchemy.id"]).toEqual("Route");
      const destinations = yield* cf
        .listDestinationsForRoute({ guid: created.route.routeId })
        .pipe(asManager(login));
      expect(destinations.destinations?.map((d) => d.app?.guid)).toEqual([created.app.appId]);

      const unchanged = yield* stack.plan(program({ host: undefined, toApp: true }));
      expect(unchanged.resources.Route).toMatchObject({ action: "noop" });

      // Dropping the app takes the destination off, and the route stays.
      const emptied = yield* stack.deploy(program({ host: undefined, toApp: false }));
      expect(emptied.route.routeId).toEqual(created.route.routeId);
      expect(emptied.route.destinations).toEqual({});
      const afterDrop = yield* cf
        .listDestinationsForRoute({ guid: created.route.routeId })
        .pipe(asManager(login));
      expect(afterDrop.destinations ?? []).toEqual([]);

      // A new host is a new route, and the old one goes.
      const moved = yield* stack.deploy(program({ host: "alchemy-test-cf-route", toApp: false }));
      expect(moved.route.routeId).not.toEqual(created.route.routeId);
      expect(moved.route.host).toEqual("alchemy-test-cf-route");
      yield* expectGone(cf.getRoute({ guid: created.route.routeId }).pipe(asManager(login)));

      const lastRoute = moved.route.routeId;
      // The organization goes with the destroy, so the check runs on the way there.
      yield* stack.deploy(
        Effect.gen(function* () {
          const target = yield* deployer("Route");
          yield* Stackit.CloudFoundry.App("RouteApp", {
            spaceId: target.space.spaceId,
            credentials: target.credentials,
            image: EXAMPLE_IMAGE,
            memoryInMb: CF_MEMORY_IN_MB,
            noRoute: true,
          });
          return target;
        }),
      );
      yield* expectGone(cf.getRoute({ guid: lastRoute }).pipe(asManager(login)));

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);
