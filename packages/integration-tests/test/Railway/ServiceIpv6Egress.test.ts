import { ipv6EgressPatch, serviceIpv6Egress } from "@alchemy.run/railway/ServiceIpv6Egress";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

describe(
  "Railway service IPv6 egress",
  { tags: ["unit", "provider:railway", "provider:railway:service", "local"] },
  () => {
    it.effect("reads deploy.ipv6EgressEnabled for the one service", () =>
      Effect.gen(function* () {
        const config = {
          services: {
            api: { deploy: { ipv6EgressEnabled: true } },
            worker: { deploy: { ipv6EgressEnabled: false } },
          },
        };

        expect(yield* serviceIpv6Egress(config, "api")).toEqual(Option.some(true));
        expect(yield* serviceIpv6Egress(config, "worker")).toEqual(Option.some(false));
      }),
    );

    it.effect("reports none when Railway has not stored a value", () =>
      Effect.gen(function* () {
        for (const config of [
          {},
          { services: null },
          { services: {} },
          { services: { api: null } },
          { services: { api: {} } },
          { services: { api: { deploy: null } } },
          { services: { api: { deploy: {} } } },
          { services: { api: { deploy: { ipv6EgressEnabled: null } } } },
        ]) {
          expect(yield* serviceIpv6Egress(config, "api")).toEqual(Option.none());
        }
      }),
    );

    it.effect("fails on a config whose shape Railway changed", () =>
      Effect.gen(function* () {
        const error = yield* serviceIpv6Egress(
          { services: { api: { deploy: { ipv6EgressEnabled: "yes" } } } },
          "api",
        ).pipe(Effect.flip);
        expect(error._tag).toEqual("SchemaError");
      }),
    );

    it("writes only when the observed value differs", () => {
      expect(ipv6EgressPatch(true, Option.none())).toEqual(
        Option.some({ ipv6EgressEnabled: true }),
      );
      expect(ipv6EgressPatch(true, Option.some(false))).toEqual(
        Option.some({ ipv6EgressEnabled: true }),
      );
      expect(ipv6EgressPatch(false, Option.some(true))).toEqual(
        Option.some({ ipv6EgressEnabled: false }),
      );
      expect(ipv6EgressPatch(true, Option.some(true))).toEqual(Option.none());
      expect(ipv6EgressPatch(false, Option.some(false))).toEqual(Option.none());
      // an explicit `false` is still a write when Railway has no value stored
      expect(ipv6EgressPatch(false, Option.none())).toEqual(
        Option.some({ ipv6EgressEnabled: false }),
      );
    });
  },
);
