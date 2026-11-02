import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

// Unattached network interfaces are free, so the suite is ungated.
const options = { tags: stackitTags("iaas", "networkinterface"), timeout: 600_000 } as const;

const observe = (projectId: string, region: string, nicId: string) =>
  iaas
    .getProjectNIC({ projectId, region, nicId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

const expectGone = (projectId: string, region: string, nicId: string) =>
  observe(projectId, region, nicId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (nic) => nic === "gone",
      times: 10,
    }),
    Effect.map((nic) => expect(nic).toEqual("gone")),
  );

const withNic = (props: Omit<Stackit.IaaS.NetworkInterfaceProps, "networkId" | "securityGroups">) =>
  Effect.gen(function* () {
    const network = yield* Stackit.IaaS.Network("NicNetwork", {
      ipv4: { prefix: "10.231.20.0/24" },
    });
    const group = yield* Stackit.IaaS.SecurityGroup("NicGroup", {});
    const nic = yield* Stackit.IaaS.NetworkInterface("Nic", {
      networkId: network.networkId,
      securityGroups: [group.securityGroupId],
      ...props,
    });
    return { network, group, nic };
  });

test.provider(
  "create, update, replace and delete a network interface",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        withNic({ ipv4: "10.231.20.10", labels: { env: "test" } }),
      );
      expect(created.nic.networkInterfaceId).toEqual(expect.any(String));
      expect(created.nic.networkId).toEqual(created.network.networkId);
      expect(created.nic.ipv4).toEqual("10.231.20.10");
      expect(created.nic.nicSecurity).toEqual(true);
      expect(created.nic.securityGroups).toEqual([created.group.securityGroupId]);
      expect(created.nic.mac).toEqual(expect.stringMatching(/^[0-9a-f:]{17}$/i));

      const fetched = yield* iaas.getNic({
        projectId,
        region,
        networkId: created.network.networkId,
        nicId: created.nic.networkInterfaceId,
      });
      expect(fetched.ipv4).toEqual("10.231.20.10");
      expect(fetched.securityGroups).toEqual([created.group.securityGroupId]);
      expect(Stackit.labelRecord(fetched.labels)).toMatchObject({
        env: "test",
        "alchemy.id": "Nic",
      });

      const updated = yield* stack.deploy(
        withNic({
          ipv4: "10.231.20.10",
          name: "alchemy-iaas-nic-renamed",
          description: "updated",
          allowedAddresses: ["10.231.20.100/32"],
          labels: { env: "prod" },
        }),
      );
      expect(updated.nic.networkInterfaceId).toEqual(created.nic.networkInterfaceId);
      expect(updated.nic.name).toEqual("alchemy-iaas-nic-renamed");

      const refetched = yield* iaas.getNic({
        projectId,
        region,
        networkId: created.network.networkId,
        nicId: created.nic.networkInterfaceId,
      });
      expect(refetched.name).toEqual("alchemy-iaas-nic-renamed");
      expect(refetched.description).toEqual("updated");
      expect(refetched.allowedAddresses).toEqual(["10.231.20.100/32"]);
      expect(Stackit.stripInternalLabels(refetched.labels)).toEqual({ env: "prod" });

      // A new fixed address replaces the interface.
      const replaced = yield* stack.deploy(
        withNic({ ipv4: "10.231.20.11", name: "alchemy-iaas-nic-renamed" }),
      );
      expect(replaced.nic.networkInterfaceId).not.toEqual(created.nic.networkInterfaceId);
      expect(replaced.nic.ipv4).toEqual("10.231.20.11");
      yield* expectGone(projectId, region, created.nic.networkInterfaceId);

      yield* stack.destroy();
      yield* expectGone(projectId, region, replaced.nic.networkInterfaceId);
    }).pipe(logLevel),
  options,
);
