import { ipv6EgressPatch, serviceIpv6Egress } from "@alchemy.run/railway/ServiceIpv6Egress";
import { describe, expect, it } from "@alchemy.run/test";

describe(
  "Railway service IPv6 egress",
  { tags: ["unit", "provider:railway", "provider:railway:service", "local"] },
  () => {
    it("reads deploy.ipv6EgressEnabled for the one service", () => {
      const config = {
        services: {
          api: { deploy: { ipv6EgressEnabled: true } },
          worker: { deploy: { ipv6EgressEnabled: false } },
        },
      };

      expect(serviceIpv6Egress(config, "api")).toEqual(true);
      expect(serviceIpv6Egress(config, "worker")).toEqual(false);
    });

    it("reports unset when Railway has not stored a value", () => {
      expect(serviceIpv6Egress(undefined, "api")).toBeUndefined();
      expect(serviceIpv6Egress({ services: {} }, "api")).toBeUndefined();
      expect(serviceIpv6Egress({ services: { api: {} } }, "api")).toBeUndefined();
      expect(serviceIpv6Egress({ services: { api: { deploy: {} } } }, "api")).toBeUndefined();
      expect(
        serviceIpv6Egress({ services: { api: { deploy: { ipv6EgressEnabled: "yes" } } } }, "api"),
      ).toBeUndefined();
    });

    it("writes only when the observed value differs", () => {
      expect(ipv6EgressPatch(true, undefined)).toEqual({ ipv6EgressEnabled: true });
      expect(ipv6EgressPatch(true, false)).toEqual({ ipv6EgressEnabled: true });
      expect(ipv6EgressPatch(false, true)).toEqual({ ipv6EgressEnabled: false });
      expect(ipv6EgressPatch(true, true)).toBeUndefined();
      expect(ipv6EgressPatch(false, false)).toBeUndefined();
      // an explicit `false` is still a write when Railway has no value stored
      expect(ipv6EgressPatch(false, undefined)).toEqual({ ipv6EgressEnabled: false });
    });
  },
);
