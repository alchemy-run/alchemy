import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as vpn from "@distilled.cloud/stackit/vpn";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import {
  expectGatewayGone,
  GATEWAY_QUOTA,
  PLAN,
  PRE_SHARED_KEY,
  ROTATED_KEY,
  slow,
  SUITE_TIMEOUT,
  tunnel,
  zones,
} from "./vpn.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("vpn", "connection"), timeout: SUITE_TIMEOUT } as const;

// Three gateways on the smallest plan, about EUR 0.26 per run. See `vpn.ts`.
describe.sequential.skipIf(slow)("STACKIT VPN Connection", { tags: options.tags }, () => {
  test.provider(
    "create, update, rotate a key, and move to another gateway",
    (stack) =>
      Effect.gen(function* () {
        const { projectId, region } = yield* stackitEnvironment;
        const place = { projectId, region };
        yield* stack.destroy();

        // Both gateways stay deployed through every step: the old gateway must not be
        // removed in the deploy that replaces the connection using it.
        const app = (props: {
          onSecond?: boolean;
          enabled?: boolean;
          remoteSubnets: string[];
          key?: Redacted.Redacted<string>;
          labels: Record<string, string>;
        }) =>
          Effect.gen(function* () {
            const first = yield* Stackit.VPN.Gateway("FirstGateway", {
              planId: PLAN,
              routingType: "POLICY_BASED",
              availabilityZones: zones(region),
            });
            const second = yield* Stackit.VPN.Gateway("SecondGateway", {
              planId: PLAN,
              routingType: "POLICY_BASED",
              availabilityZones: zones(region),
            });
            const gateway = props.onSecond ? second : first;
            const connection = yield* Stackit.VPN.Connection("LifecycleConnection", {
              gatewayId: gateway.gatewayId,
              localSubnets: ["10.231.71.0/24"],
              remoteSubnets: props.remoteSubnets,
              tunnel1: tunnel("203.0.113.20", props.key),
              tunnel2: tunnel("203.0.113.21", props.key),
              labels: props.labels,
              ...(props.enabled === undefined ? {} : { enabled: props.enabled }),
            });
            return { connection, gatewayId: gateway.gatewayId };
          });

        const created = yield* stack.deploy(
          app({ remoteSubnets: ["192.168.71.0/24"], labels: { env: "test" } }),
        );
        const { connectionId, gatewayId } = created.connection;
        expect(connectionId).toMatch(/^[0-9a-f-]{36}$/);
        expect(created.connection.enabled).toEqual(true);
        expect(created.connection.labels).toEqual({ env: "test" });
        // The key is not an attribute, in any form.
        expect(JSON.stringify(created.connection)).not.toContain(Redacted.value(PRE_SHARED_KEY));
        expect("preSharedKey" in created.connection.tunnel1).toEqual(false);

        // Out of band: the configuration and Alchemy's ownership labels, and no key.
        const scope = { ...place, gatewayId, connectionId };
        const fetched = yield* vpn.getGatewayConnection(scope);
        expect(fetched.displayName).toEqual(created.connection.displayName);
        expect(fetched.remoteSubnets).toEqual(["192.168.71.0/24"]);
        expect(fetched.tunnel1.remoteAddress).toEqual("203.0.113.20");
        expect(fetched.tunnel1.phase1.encryptionAlgorithms).toEqual(["aes256"]);
        expect(Stackit.labelRecord(fetched.labels)).toMatchObject({
          env: "test",
          "alchemy.id": "LifecycleConnection",
        });
        const gatewayAfterCreate = yield* vpn.getGateway({ ...place, gatewayId });
        expect(gatewayAfterCreate.state).toEqual("READY");

        // Redeploying unchanged is a no-op, with the key among the props.
        const noop = yield* stack.plan(
          app({ remoteSubnets: ["192.168.71.0/24"], labels: { env: "test" } }),
        );
        expect(noop.resources.LifecycleConnection).toMatchObject({ action: "noop" });

        // A new key alone is an update, though STACKIT never returns one to compare with.
        const rotation = yield* stack.plan(
          app({ remoteSubnets: ["192.168.71.0/24"], key: ROTATED_KEY, labels: { env: "test" } }),
        );
        expect(rotation.resources.LifecycleConnection).toMatchObject({ action: "update" });
        const rotated = yield* stack.deploy(
          app({ remoteSubnets: ["192.168.71.0/24"], key: ROTATED_KEY, labels: { env: "test" } }),
        );
        expect(rotated.connection.connectionId).toEqual(connectionId);

        // Subnets, state and labels update in place, and the key stays through it.
        const updated = yield* stack.deploy(
          app({
            remoteSubnets: ["192.168.72.0/24"],
            enabled: false,
            key: ROTATED_KEY,
            labels: { env: "prod" },
          }),
        );
        expect(updated.connection.connectionId).toEqual(connectionId);
        expect(updated.connection.enabled).toEqual(false);
        const refetched = yield* vpn.getGatewayConnection(scope);
        expect(refetched.enabled).toEqual(false);
        expect(refetched.remoteSubnets).toEqual(["192.168.72.0/24"]);
        expect(Stackit.stripInternalLabels(refetched.labels)).toEqual({ env: "prod" });
        // Neighboring settings survive the full-body update.
        expect(refetched.localSubnets).toEqual(["10.231.71.0/24"]);
        expect(refetched.tunnel2.remoteAddress).toEqual("203.0.113.21");

        // Nuke's enumeration finds it.
        const provider = yield* Provider.findProvider(Stackit.VPN.Connection);
        const all = yield* provider.list();
        expect(all.find((item) => item.connectionId === connectionId)?.gatewayId).toEqual(
          gatewayId,
        );

        // Another gateway replaces it, and the old connection goes.
        const moved = yield* stack.deploy(
          app({
            onSecond: true,
            remoteSubnets: ["192.168.72.0/24"],
            key: ROTATED_KEY,
            labels: { env: "prod" },
          }),
        );
        expect(moved.connection.connectionId).not.toEqual(connectionId);
        expect(moved.connection.gatewayId).not.toEqual(gatewayId);
        const old = yield* vpn
          .getGatewayConnection(scope)
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));
        expect(old).toEqual("gone");

        yield* stack.destroy();
        yield* expectGatewayGone(place, gatewayId);
        yield* expectGatewayGone(place, moved.gatewayId);
      }).pipe(logLevel),
    { ...options, exclusive: GATEWAY_QUOTA },
  );

  test.provider(
    "static routes on a route-based gateway, and removing them clears them",
    (stack) =>
      Effect.gen(function* () {
        const { projectId, region } = yield* stackitEnvironment;
        const place = { projectId, region };
        yield* stack.destroy();

        const app = (staticRoutes: string[] | undefined) =>
          Effect.gen(function* () {
            const gateway = yield* Stackit.VPN.Gateway("RouteGateway", {
              planId: PLAN,
              routingType: "ROUTE_BASED",
              availabilityZones: zones(region),
            });
            const connection = yield* Stackit.VPN.Connection("RouteConnection", {
              gatewayId: gateway.gatewayId,
              displayName: "alchemy-test-vpn-routes",
              tunnel1: {
                ...tunnel("203.0.113.30"),
                peering: { localAddress: "169.254.30.1", remoteAddress: "169.254.30.2" },
              },
              tunnel2: {
                ...tunnel("203.0.113.31"),
                peering: { localAddress: "169.254.31.1", remoteAddress: "169.254.31.2" },
              },
              ...(staticRoutes === undefined ? {} : { staticRoutes }),
            });
            return { connection, gatewayId: gateway.gatewayId };
          });

        const created = yield* stack.deploy(app(["192.168.73.0/24"]));
        expect(created.connection.displayName).toEqual("alchemy-test-vpn-routes");
        const scope = {
          ...place,
          gatewayId: created.gatewayId,
          connectionId: created.connection.connectionId,
        };
        const fetched = yield* vpn.getGatewayConnection(scope);
        expect(fetched.staticRoutes).toEqual(["192.168.73.0/24"]);

        const cleared = yield* stack.deploy(app(undefined));
        expect(cleared.connection.connectionId).toEqual(created.connection.connectionId);
        const refetched = yield* vpn.getGatewayConnection(scope);
        expect(refetched.staticRoutes ?? []).toEqual([]);

        yield* stack.destroy();
        const gone = yield* vpn
          .getGatewayConnection(scope)
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));
        expect(gone).toEqual("gone");
        yield* expectGatewayGone(place, created.gatewayId);
      }).pipe(logLevel),
    options,
  );
});
