import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

// A public IP is billed per hour while allocated (fractions of a cent for
// the minutes this suite holds one), so the suite is ungated.
const options = { tags: stackitTags("iaas", "publicip"), timeout: 600_000 } as const;

const observe = (projectId: string, region: string, publicIpId: string) =>
  iaas
    .getPublicIP({ projectId, region, publicIpId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

const expectGone = (projectId: string, region: string, publicIpId: string) =>
  observe(projectId, region, publicIpId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (ip) => ip === "gone",
      times: 10,
    }),
    Effect.map((ip) => expect(ip).toEqual("gone")),
  );

const ipFor = (associate: boolean, labels: Record<string, string>) =>
  Effect.gen(function* () {
    const network = yield* Stackit.IaaS.Network("IpNetwork", {
      ipv4: { prefix: "10.231.30.0/24" },
    });
    const nic = yield* Stackit.IaaS.NetworkInterface("IpNic", { networkId: network.networkId });
    const ip = yield* Stackit.IaaS.PublicIp("Ip", {
      networkInterfaceId: associate ? nic.networkInterfaceId : null,
      labels,
    });
    return { nic, ip };
  });

test.provider(
  "allocate, associate, dissociate and release a public IP",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(ipFor(false, { env: "test" }));
      expect(created.ip.publicIpId).toEqual(expect.any(String));
      expect(created.ip.ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect(created.ip.networkInterfaceId).toBeUndefined();
      expect(created.ip.labels).toEqual({ env: "test" });

      const fetched = yield* iaas.getPublicIP({
        projectId,
        region,
        publicIpId: created.ip.publicIpId,
      });
      expect(fetched.ip).toEqual(created.ip.ip);
      expect(Stackit.labelRecord(fetched.labels)).toMatchObject({ "alchemy.id": "Ip" });

      // Associate with the interface and relabel, keeping the address.
      const associated = yield* stack.deploy(ipFor(true, { env: "prod" }));
      expect(associated.ip.publicIpId).toEqual(created.ip.publicIpId);
      expect(associated.ip.ip).toEqual(created.ip.ip);
      expect(associated.ip.networkInterfaceId).toEqual(associated.nic.networkInterfaceId);

      const refetched = yield* iaas.getPublicIP({
        projectId,
        region,
        publicIpId: created.ip.publicIpId,
      });
      expect(refetched.networkInterface).toEqual(associated.nic.networkInterfaceId);
      expect(Stackit.stripInternalLabels(refetched.labels)).toEqual({ env: "prod" });

      // `null` dissociates.
      const dissociated = yield* stack.deploy(ipFor(false, { env: "prod" }));
      expect(dissociated.ip.networkInterfaceId).toBeUndefined();
      const afterDissociate = yield* iaas.getPublicIP({
        projectId,
        region,
        publicIpId: created.ip.publicIpId,
      });
      expect(afterDissociate.networkInterface ?? null).toBeNull();

      yield* stack.destroy();
      yield* expectGone(projectId, region, created.ip.publicIpId);
    }).pipe(logLevel),
  options,
);
