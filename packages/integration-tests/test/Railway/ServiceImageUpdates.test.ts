import {
  imageUpdatesPatch,
  serviceImageUpdates,
  validateImageUpdates,
} from "@alchemy.run/railway/ServiceImageUpdates";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

describe(
  "Railway image update policy",
  { tags: ["unit", "provider:railway", "provider:railway:service", "local"] },
  () => {
    it.effect("reads source.autoUpdates for the service and ignores other services", () =>
      Effect.gen(function* () {
        const config = {
          services: {
            db: {
              source: {
                image: "ghcr.io/railwayapp-templates/postgres-ssl:18",
                autoUpdates: {
                  type: "patch",
                  tagMode: "sha",
                  schedule: [{ day: 6, startHour: 10, endHour: 24 }],
                },
              },
            },
            web: { source: { image: "nginx", autoUpdates: { type: "minor" } } },
          },
        };

        expect(yield* serviceImageUpdates(config, "db")).toEqual({
          type: "patch",
          tagMode: "sha",
          schedule: [{ day: 6, startHour: 10, endHour: 24 }],
        });
        expect(yield* serviceImageUpdates(config, "web")).toEqual({ type: "minor" });
      }),
    );

    it.effect("reads an empty policy when the config has none", () =>
      Effect.gen(function* () {
        for (const config of [
          {},
          { services: null },
          { services: { db: null } },
          { services: { db: { source: null } } },
          { services: { db: { source: { image: "nginx" } } } },
          { services: { db: { source: { autoUpdates: null } } } },
        ]) {
          expect(yield* serviceImageUpdates(config, "db")).toEqual({});
        }
      }),
    );

    it.effect("fails on a policy whose shape Railway changed", () =>
      Effect.gen(function* () {
        const error = yield* serviceImageUpdates(
          { services: { db: { source: { autoUpdates: { schedule: "weekends" } } } } },
          "db",
        ).pipe(Effect.flip);
        expect(error._tag).toEqual("SchemaError");
      }),
    );

    it("keeps a type Alchemy does not know so it is overwritten", () => {
      expect(imageUpdatesPatch({ type: "patch" }, { type: "other" })).toEqual(
        Option.some({ type: "patch" }),
      );
    });

    it("writes only the fields that differ", () => {
      const observed = {
        type: "patch",
        tagMode: "semver",
        schedule: [{ day: 6, startHour: 2, endHour: 6 }],
      };

      expect(imageUpdatesPatch({ type: "minor", tagMode: "semver" }, observed)).toEqual(
        Option.some({ type: "minor" }),
      );
      expect(imageUpdatesPatch({ type: "patch", tagMode: "sha" }, observed)).toEqual(
        Option.some({ tagMode: "sha" }),
      );
      expect(
        imageUpdatesPatch(
          { type: "patch", schedule: [{ day: 0, startHour: 0, endHour: 24 }] },
          observed,
        ),
      ).toEqual(Option.some({ schedule: [{ day: 0, startHour: 0, endHour: 24 }] }));
    });

    it("writes nothing when Railway already has the policy, in any window order", () => {
      const observed = {
        type: "patch",
        tagMode: "sha",
        schedule: [
          { day: 0, startHour: 0, endHour: 24 },
          { day: 6, startHour: 0, endHour: 24 },
        ],
      };

      expect(
        imageUpdatesPatch(
          {
            type: "patch",
            tagMode: "sha",
            schedule: [
              { day: 6, startHour: 0, endHour: 24 },
              { day: 0, startHour: 0, endHour: 24 },
            ],
          },
          observed,
        ),
      ).toEqual(Option.none());
    });

    it("leaves fields the caller omitted alone", () => {
      expect(
        imageUpdatesPatch(
          { type: "patch" },
          { type: "patch", tagMode: "sha", schedule: [{ day: 6, startHour: 2, endHour: 6 }] },
        ),
      ).toEqual(Option.none());
    });

    it("treats a missing schedule and an empty one as the same", () => {
      expect(imageUpdatesPatch({ type: "patch", schedule: [] }, { type: "patch" })).toEqual(
        Option.none(),
      );
      expect(
        imageUpdatesPatch(
          { type: "patch", schedule: [] },
          { type: "patch", schedule: [{ day: 1, startHour: 1, endHour: 2 }] },
        ),
      ).toEqual(Option.some({ schedule: [] }));
    });

    it.effect("accepts every documented type, tag mode, and window bound", () =>
      Effect.gen(function* () {
        for (const type of ["disabled", "patch", "minor"] as const) {
          expect(yield* validateImageUpdates({ type })).toEqual({ type });
        }
        for (const tagMode of ["semver", "sha"] as const) {
          expect(yield* validateImageUpdates({ type: "patch", tagMode })).toEqual({
            type: "patch",
            tagMode,
          });
        }
        const edges = {
          type: "patch",
          schedule: [
            { day: 0, startHour: 0, endHour: 1 },
            { day: 6, startHour: 23, endHour: 24 },
          ],
        };
        expect(yield* validateImageUpdates(edges)).toEqual(edges);
      }),
    );

    it.effect("rejects values Railway does not accept before any write", () =>
      Effect.gen(function* () {
        const window = (day: number, startHour: number, endHour: number) => ({
          type: "patch",
          schedule: [{ day, startHour, endHour }],
        });
        for (const bad of [
          { type: "weekly" },
          { type: "patch", tagMode: "tag" },
          window(7, 0, 1),
          window(-1, 0, 1),
          window(0, 24, 24),
          window(0, 0, 0),
          window(0, 5, 5),
          window(0, 6, 2),
          window(0, 0, 25),
          window(0.5, 0, 1),
        ]) {
          const error = yield* validateImageUpdates(bad).pipe(Effect.flip);
          expect(error._tag).toEqual("Railway.ServiceImageUpdatesInvalid");
        }
      }),
    );
  },
);
