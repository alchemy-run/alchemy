import * as Mux from "@alchemy.run/mux";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Data from "@distilled.cloud/mux/data";
import * as Drift from "alchemy/Drift";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: Mux.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const live = (id: string) =>
  Data.getAnnotation({ ANNOTATION_ID: id }).pipe(Effect.map((res) => res.data));

const status = (id: string) =>
  live(id).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
  );

const waitUntilGone = (id: string) =>
  status(id).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (s) => s === "gone",
      times: 10,
    }),
  );

const unixSeconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** Retained markers outlive `stack.destroy()`, so the test deletes them by note. */
const deleteRetained = (prefix: string) =>
  Data.listAnnotations.items({ limit: 100, timeframe__: ["7:days"] }).pipe(
    Stream.filter((annotation) => annotation.note.startsWith(prefix)),
    Stream.runForEach((annotation) =>
      Data.deleteAnnotation({ ANNOTATION_ID: annotation.id }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
      ),
    ),
  );

const markers = (tag: string, version: string, pinnedDate: number) =>
  Effect.gen(function* () {
    const marker = yield* Mux.Data.Annotation("Marker", { note: `${tag} ${version}` });
    const pinned = yield* Mux.Data.Annotation("Pinned", {
      note: `${tag} pinned`,
      date: pinnedDate,
    });
    const kept = yield* Mux.Data.Annotation("Kept", { note: `${tag} kept ${version}` }).pipe(
      RemovalPolicy.retain(),
    );
    return { marker, pinned, kept };
  });

test.provider(
  "create, replace on a note change, keep retained markers, and repair drift",
  (stack) =>
    Effect.gen(function* () {
      const tag = `alchemy-test-annotation-${stack.stage}`;
      yield* stack.destroy();
      yield* deleteRetained(tag);
      // A day before the run: Mux never accepts a note again at the date of
      // a deleted annotation, so each run pins its own second.
      const pinnedDate = Math.floor(Date.now() / 1000) - 86_400;

      const created = yield* stack.deploy(markers(tag, "v1", pinnedDate));
      const marker = yield* live(created.marker.id);
      expect(marker.note).toEqual(`${tag} v1`);
      const age = Date.now() / 1000 - unixSeconds(marker.date);
      expect(age).toBeGreaterThan(-60);
      expect(age).toBeLessThan(600);
      expect(unixSeconds((yield* live(created.pinned.id)).date)).toEqual(pinnedDate);

      const renoted = yield* stack.deploy(markers(tag, "v2", pinnedDate));
      expect(renoted.marker.id).not.toEqual(created.marker.id);
      expect((yield* live(renoted.marker.id)).note).toEqual(`${tag} v2`);
      expect(yield* waitUntilGone(created.marker.id)).toEqual("gone");
      expect(renoted.pinned.id).toEqual(created.pinned.id);
      expect(renoted.kept.id).not.toEqual(created.kept.id);
      expect(yield* status(created.kept.id)).toEqual("found");

      for (const annotation of [renoted.marker, renoted.pinned]) {
        yield* Data.updateAnnotation({
          ANNOTATION_ID: annotation.id,
          note: "changed outside alchemy",
          date: unixSeconds(annotation.date) - 3600,
          sub_property_id: "added-outside-alchemy",
        });
      }
      const drift = yield* Drift.detect(stack).pipe(Effect.provide(stack.state));
      expect(drift.resources.Marker?.action).toBe("drifted");
      expect(drift.resources.Pinned?.action).toBe("drifted");
      expect(drift.resources.Kept?.action).toBe("unchanged");
      yield* Drift.repair(stack).pipe(Effect.provide(stack.state));
      const settled = yield* Drift.detect(stack).pipe(Effect.provide(stack.state));
      expect(settled.resources.Marker?.action).toBe("unchanged");
      expect(settled.resources.Pinned?.action).toBe("unchanged");

      const repairedMarker = yield* live(renoted.marker.id);
      expect(repairedMarker.note).toEqual(`${tag} v2`);
      expect(repairedMarker.sub_property_id ?? undefined).toBeUndefined();
      // With no `date` prop, the date is Mux's to keep once the marker exists.
      expect(unixSeconds(repairedMarker.date)).toEqual(unixSeconds(renoted.marker.date) - 3600);
      const repairedPinned = yield* live(renoted.pinned.id);
      expect(repairedPinned.note).toEqual(`${tag} pinned`);
      expect(unixSeconds(repairedPinned.date)).toEqual(pinnedDate);

      yield* stack.destroy();
      expect(yield* waitUntilGone(renoted.marker.id)).toEqual("gone");
      expect(yield* waitUntilGone(renoted.pinned.id)).toEqual("gone");
      expect(yield* status(renoted.kept.id)).toEqual("found");
      yield* deleteRetained(tag);
    }).pipe(logLevel),
  { tags: ["provider:mux", "provider:mux:data", "live"], timeout: 180_000 },
);

test.provider(
  "drift repair recreates an annotation deleted outside Alchemy",
  (stack) =>
    Effect.gen(function* () {
      const tag = `alchemy-test-annotation-gone-${stack.stage}`;
      yield* stack.destroy();
      const marker = Mux.Data.Annotation("Marker", { note: tag });

      const first = yield* stack.deploy(marker);
      yield* Data.deleteAnnotation({ ANNOTATION_ID: first.id });
      // Mux rejects a note re-created at the same second as a deleted one
      // ("Missing required fields"), so the recreate must land a second later.
      yield* Effect.sleep("1100 millis");

      const drift = yield* Drift.detect(stack).pipe(Effect.provide(stack.state));
      expect(drift.resources.Marker?.action).toBe("missing");
      yield* Drift.repair(stack).pipe(Effect.provide(stack.state));

      const second = yield* stack.deploy(marker);
      expect(second.id).not.toEqual(first.id);
      expect((yield* live(second.id)).note).toEqual(tag);

      yield* stack.destroy();
      expect(yield* waitUntilGone(second.id)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:mux", "provider:mux:data", "live"], timeout: 120_000 },
);
