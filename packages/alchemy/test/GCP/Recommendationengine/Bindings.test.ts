import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  entitlementTags,
  hasGcpCreds,
  logLevel,
  probeCatalogAccess,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "GetCatalogItem round-trip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* probeCatalogAccess;
      if (access !== "ok") {
        expect(entitlementTags).toContain(access._tag);
        if (access._tag === "Forbidden") {
          expect(access.message).toContain(
            "Recommendations AI (Beta) has not been used",
          );
        }
        yield* stack.destroy();
        return;
      }

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const item = yield* GCP.Recommendationengine.CatalogsCatalogItem(
            "Shirt",
            {
              title: "Cotton tee",
              categoryHierarchies: [{ categories: ["Apparel", "T-Shirts"] }],
            },
          );
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* item.name;
              const getCatalogItem =
                yield* GCP.Recommendationengine.GetCatalogItem(item);
              return Effect.fn(function* () {
                return yield* getCatalogItem();
              });
            }),
          );
          return {
            catalogItemId: yield* item.catalogItemId,
            live: yield* Probe({}),
          };
        }),
      );

      expect(out.live.id).toEqual(out.catalogItemId);
      expect(out.live.title).toEqual("Cotton tee");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
