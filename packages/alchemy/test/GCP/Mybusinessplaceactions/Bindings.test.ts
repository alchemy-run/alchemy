import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  entitlementTags,
  hasGcpCreds,
  logLevel,
  probeCreateAccess,
  testParent,
  testUri,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "GetPlaceActionLink round-trip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* probeCreateAccess;
      if (access !== "ok") {
        expect([...entitlementTags]).toContain(access._tag);
        yield* stack.destroy();
        return;
      }

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const link = yield* GCP.Mybusinessplaceactions.PlaceActionLink(
            "Shop",
            {
              parent: testParent,
              uri: testUri,
              placeActionType: "SHOP_ONLINE",
            },
          );
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* link.name;
              const getLink =
                yield* GCP.Mybusinessplaceactions.GetPlaceActionLink(link);
              return Effect.fn(function* () {
                return yield* getLink({});
              });
            }),
          );
          return { link, current: yield* Probe({}) };
        }),
      );

      expect(out.current.name).toEqual(out.link.name);
      expect(out.current.uri).toContain("alchemy-");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
