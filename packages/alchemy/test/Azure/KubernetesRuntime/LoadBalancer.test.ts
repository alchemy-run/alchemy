import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as kr from "@distilled.cloud/azure/kubernetesruntime";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { arcClusterId, logLevel, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getLoadBalancer = (clusterId: string, loadBalancerName: string) =>
  kr.GetLoadBalancer({ resourceUri: clusterId, loadBalancerName });

const program = (props: {
  addresses: string[];
  serviceSelector?: Record<string, string>;
  name?: string;
}) =>
  Effect.gen(function* () {
    const networking = yield* Azure.KubernetesRuntime.Service("Networking", {
      clusterId: arcClusterId!,
      serviceName: "networking",
    });
    const loadBalancer = yield* Azure.KubernetesRuntime.LoadBalancer("Pool", {
      clusterId: networking.clusterId,
      name: props.name,
      addresses: props.addresses,
      advertiseMode: "ARP",
      serviceSelector: props.serviceSelector,
    });
    return { loadBalancer };
  });

// Needs a connected Arc cluster with Arc networking (see util.ts); the
// address pool itself is free.
test.provider.skipIf(!arcClusterId)(
  "create, update, replace, and delete a load balancer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const clusterId = arcClusterId!;

      const { loadBalancer } = yield* stack.deploy(
        program({ addresses: ["192.168.240.0/29"] }),
      );
      const observed = yield* getLoadBalancer(
        clusterId,
        loadBalancer.loadBalancerName,
      );
      expect(observed.properties?.addresses).toEqual(["192.168.240.0/29"]);
      expect(observed.properties?.advertiseMode).toEqual("ARP");

      // In place: addresses and selector are mutable via PUT.
      const updated = yield* stack.deploy(
        program({
          addresses: ["192.168.240.8/29"],
          serviceSelector: { exposure: "lan" },
        }),
      );
      expect(updated.loadBalancer.loadBalancerId).toEqual(
        loadBalancer.loadBalancerId,
      );
      const reobserved = yield* getLoadBalancer(
        clusterId,
        loadBalancer.loadBalancerName,
      );
      expect(reobserved.properties?.addresses).toEqual(["192.168.240.8/29"]);
      expect(reobserved.properties?.serviceSelector).toEqual({
        exposure: "lan",
      });

      // Replacement: the name is the identity.
      const replaced = yield* stack.deploy(
        program({ addresses: ["192.168.240.8/29"], name: "alchemy-pool-b" }),
      );
      expect(replaced.loadBalancer.loadBalancerName).toEqual("alchemy-pool-b");
      expect(
        (yield* getLoadBalancer(clusterId, "alchemy-pool-b")).properties
          ?.addresses,
      ).toEqual(["192.168.240.8/29"]);
      expect(
        yield* waitGone(
          getLoadBalancer(clusterId, loadBalancer.loadBalancerName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(getLoadBalancer(clusterId, "alchemy-pool-b")),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
