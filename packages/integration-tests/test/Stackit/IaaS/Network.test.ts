import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

// Networks are free (a project's first network with internet access adds
// a small SNAT gateway charge), so the suite is ungated.
const options = { tags: stackitTags("iaas", "network"), timeout: 600_000 } as const;

/** Out-of-band: the network as STACKIT reports it, or `"gone"`. */
const observe = (projectId: string, region: string, networkId: string) =>
  iaas
    .getNetwork({ projectId, region, networkId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

// The provider already waits for the delete; this absorbs read lag only.
const expectGone = (projectId: string, region: string, networkId: string) =>
  observe(projectId, region, networkId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (network) => network === "gone",
      times: 10,
    }),
    Effect.map((network) => expect(network).toEqual("gone")),
  );

test.provider(
  "create, update and delete a network",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Stackit.IaaS.Network("App", {
          ipv4: { prefix: "10.231.1.0/24", nameservers: ["1.1.1.1"] },
          labels: { env: "test" },
        }),
      );

      expect(created.networkId).toEqual(expect.any(String));
      expect(created.projectId).toEqual(projectId);
      expect(created.region).toEqual(region);
      expect(created.status).toEqual("CREATED");
      expect(created.ipv4Prefixes).toEqual(["10.231.1.0/24"]);
      expect(created.ipv4Nameservers).toEqual(["1.1.1.1"]);
      expect(created.dhcp).toEqual(true);
      expect(created.isolated).toEqual(false);
      expect(created.labels).toEqual({ env: "test" });

      const fetched = yield* iaas.getNetwork({ projectId, region, networkId: created.networkId });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.ipv4?.prefixes).toEqual(["10.231.1.0/24"]);
      expect(Stackit.labelRecord(fetched.labels)).toMatchObject({
        env: "test",
        "alchemy.id": "App",
      });

      // Update every mutable aspect in place.
      const updated = yield* stack.deploy(
        Stackit.IaaS.Network("App", {
          name: "alchemy-iaas-network-renamed",
          description: "updated by alchemy",
          dhcp: false,
          ipv4: { prefix: "10.231.1.0/24", nameservers: ["9.9.9.9", "1.1.1.1"] },
          labels: { env: "prod", tier: "app" },
        }),
      );

      expect(updated.networkId).toEqual(created.networkId);
      expect(updated.name).toEqual("alchemy-iaas-network-renamed");
      expect(updated.description).toEqual("updated by alchemy");
      expect(updated.dhcp).toEqual(false);
      expect([...updated.ipv4Nameservers].sort()).toEqual(["1.1.1.1", "9.9.9.9"]);
      expect(updated.labels).toEqual({ env: "prod", tier: "app" });

      const refetched = yield* iaas.getNetwork({ projectId, region, networkId: created.networkId });
      expect(refetched.name).toEqual("alchemy-iaas-network-renamed");
      expect(refetched.description).toEqual("updated by alchemy");
      expect(refetched.dhcp).toEqual(false);
      expect([...(refetched.ipv4?.nameservers ?? [])].sort()).toEqual(["1.1.1.1", "9.9.9.9"]);
      expect(Stackit.stripInternalLabels(refetched.labels)).toEqual({ env: "prod", tier: "app" });

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(
        Stackit.IaaS.Network("App", {
          name: "alchemy-iaas-network-renamed",
          description: "updated by alchemy",
          dhcp: false,
          ipv4: { prefix: "10.231.1.0/24", nameservers: ["9.9.9.9", "1.1.1.1"] },
          labels: { env: "prod", tier: "app" },
        }),
      );
      expect(plan.resources.App).toMatchObject({ action: "noop" });

      yield* stack.destroy();
      yield* expectGone(projectId, region, created.networkId);
    }).pipe(logLevel),
  options,
);

test.provider(
  "changing the prefix replaces the network",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Stackit.IaaS.Network("Replaced", { ipv4: { prefix: "10.231.2.0/24" } }),
      );
      const second = yield* stack.deploy(
        Stackit.IaaS.Network("Replaced", { ipv4: { prefix: "10.231.3.0/24" } }),
      );

      expect(second.networkId).not.toEqual(first.networkId);
      expect(second.ipv4Prefixes).toEqual(["10.231.3.0/24"]);
      yield* expectGone(projectId, region, first.networkId);

      const fetched = yield* iaas.getNetwork({ projectId, region, networkId: second.networkId });
      expect(fetched.ipv4?.prefixes).toEqual(["10.231.3.0/24"]);

      yield* stack.destroy();
      yield* expectGone(projectId, region, second.networkId);
    }).pipe(logLevel),
  options,
);

test.provider(
  "creates an isolated network",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const network = yield* stack.deploy(
        Stackit.IaaS.Network("Isolated", {
          isolated: true,
          ipv4: { prefix: "192.168.231.0/24" },
        }),
      );
      expect(network.isolated).toEqual(true);
      expect(network.ipv4Prefixes).toEqual(["192.168.231.0/24"]);

      // Isolation can't change in place: it replaces the network.
      const routed = yield* stack.deploy(
        Stackit.IaaS.Network("Isolated", { ipv4: { prefix: "192.168.232.0/24" } }),
      );
      expect(routed.networkId).not.toEqual(network.networkId);
      expect(routed.isolated).toEqual(false);
      yield* expectGone(projectId, region, network.networkId);

      yield* stack.destroy();
      yield* expectGone(projectId, region, routed.networkId);
    }).pipe(logLevel),
  options,
);

test.provider(
  "replacing a network with an explicit name creates a new one and deletes the old one",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const name = "alchemy-iaas-network-explicit";
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Stackit.IaaS.Network("Explicit", { name, ipv4: { prefix: "10.231.4.0/24" } }),
      );
      expect(first.name).toEqual(name);

      const second = yield* stack.deploy(
        Stackit.IaaS.Network("Explicit", { name, ipv4: { prefix: "10.231.5.0/24" } }),
      );
      expect(second.networkId).not.toEqual(first.networkId);
      expect(second.name).toEqual(name);
      expect(second.ipv4Prefixes).toEqual(["10.231.5.0/24"]);
      yield* expectGone(projectId, region, first.networkId);

      const fetched = yield* iaas.getNetwork({ projectId, region, networkId: second.networkId });
      expect(fetched.name).toEqual(name);
      expect(fetched.status).toEqual("CREATED");

      yield* stack.destroy();
      yield* expectGone(projectId, region, second.networkId);
    }).pipe(logLevel),
  options,
);
