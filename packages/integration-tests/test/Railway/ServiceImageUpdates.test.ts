import {
  imageUpdatesPatch,
  invalidImageUpdates,
  serviceImageUpdates,
} from "@alchemy.run/railway/ServiceImageUpdates";
import { describe, expect, it } from "@alchemy.run/test";

describe(
  "Railway image update policy",
  { tags: ["unit", "provider:railway", "provider:railway:service", "local"] },
  () => {
    it("reads source.autoUpdates for the service and ignores other services", () => {
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

      expect(serviceImageUpdates(config, "db")).toEqual({
        type: "patch",
        tagMode: "sha",
        schedule: [{ day: 6, startHour: 10, endHour: 24 }],
      });
      expect(serviceImageUpdates(config, "web")).toEqual({ type: "minor" });
    });

    it("reads an empty policy when the config has none", () => {
      expect(serviceImageUpdates(undefined, "db")).toEqual({});
      expect(serviceImageUpdates({ services: {} }, "db")).toEqual({});
      expect(
        serviceImageUpdates({ services: { db: { source: { image: "nginx" } } } }, "db"),
      ).toEqual({});
      expect(
        serviceImageUpdates({ services: { db: { source: { autoUpdates: null } } } }, "db"),
      ).toEqual({});
    });

    it("keeps a type Alchemy does not know so it is overwritten", () => {
      const observed = serviceImageUpdates(
        { services: { db: { source: { autoUpdates: { type: "other" } } } } },
        "db",
      );
      expect(observed).toEqual({ type: "other" });
      expect(imageUpdatesPatch({ type: "patch" }, observed)).toEqual({ type: "patch" });
    });

    it("writes only the fields that differ", () => {
      const observed = {
        type: "patch",
        tagMode: "semver",
        schedule: [{ day: 6, startHour: 2, endHour: 6 }],
      };

      expect(imageUpdatesPatch({ type: "minor", tagMode: "semver" }, observed)).toEqual({
        type: "minor",
      });
      expect(imageUpdatesPatch({ type: "patch", tagMode: "sha" }, observed)).toEqual({
        tagMode: "sha",
      });
      expect(
        imageUpdatesPatch(
          { type: "patch", schedule: [{ day: 0, startHour: 0, endHour: 24 }] },
          observed,
        ),
      ).toEqual({ schedule: [{ day: 0, startHour: 0, endHour: 24 }] });
    });

    it("writes nothing when Railway already has the policy", () => {
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
            // Window order does not matter.
            schedule: [
              { day: 6, startHour: 0, endHour: 24 },
              { day: 0, startHour: 0, endHour: 24 },
            ],
          },
          observed,
        ),
      ).toBeUndefined();
    });

    it("leaves fields the caller omitted alone", () => {
      const observed = {
        type: "patch",
        tagMode: "sha",
        schedule: [{ day: 6, startHour: 2, endHour: 6 }],
      };

      expect(imageUpdatesPatch({ type: "patch" }, observed)).toBeUndefined();
    });

    it("treats a missing schedule and an empty one as the same", () => {
      expect(imageUpdatesPatch({ type: "patch", schedule: [] }, { type: "patch" })).toBeUndefined();
      expect(
        imageUpdatesPatch(
          { type: "patch", schedule: [] },
          { type: "patch", schedule: [{ day: 1, startHour: 1, endHour: 2 }] },
        ),
      ).toEqual({ schedule: [] });
    });

    it("accepts every documented type, tag mode, and window bound", () => {
      for (const type of ["disabled", "patch", "minor"] as const) {
        expect(invalidImageUpdates({ type })).toBeUndefined();
      }
      for (const tagMode of ["semver", "sha"] as const) {
        expect(invalidImageUpdates({ type: "patch", tagMode })).toBeUndefined();
      }
      expect(
        invalidImageUpdates({
          type: "patch",
          schedule: [
            { day: 0, startHour: 0, endHour: 1 },
            { day: 6, startHour: 23, endHour: 24 },
          ],
        }),
      ).toBeUndefined();
    });

    it("rejects values Railway does not accept before any write", () => {
      const window = (day: number, startHour: number, endHour: number) => ({
        type: "patch" as const,
        schedule: [{ day, startHour, endHour }],
      });

      expect(invalidImageUpdates({ type: "weekly" as never })).toContain("imageUpdates.type");
      expect(invalidImageUpdates({ type: "patch", tagMode: "tag" as never })).toContain(
        "imageUpdates.tagMode",
      );
      for (const bad of [
        window(7, 0, 1),
        window(-1, 0, 1),
        window(0, 24, 24),
        window(0, 0, 0),
        window(0, 5, 5),
        window(0, 6, 2),
        window(0, 0, 25),
        window(0.5, 0, 1),
      ]) {
        expect(invalidImageUpdates(bad)).toContain("imageUpdates.schedule[0]");
      }
    });
  },
);
