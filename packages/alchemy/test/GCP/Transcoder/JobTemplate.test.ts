import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as transcoder from "@distilled.cloud/gcp/transcoder_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const project = process.env.GOOGLE_PROJECT_ID ?? "alchemy-gcp-testing-83661";
const location = "us-central1";
const parent = `projects/${project}/locations/${location}`;
const missingName = `${parent}/jobTemplates/alchemy-missing-template`;

const DISABLED_MESSAGE = "Transcoder API has not been used";

const sdConfig: GCP.Transcoder.JobConfig = {
  elementaryStreams: [
    {
      key: "video-stream0",
      videoStream: {
        h264: {
          heightPixels: 360,
          widthPixels: 640,
          bitrateBps: 550000,
          frameRate: 30,
        },
      },
    },
    {
      key: "audio-stream0",
      audioStream: { codec: "aac", bitrateBps: 64000 },
    },
  ],
  muxStreams: [
    {
      key: "sd",
      container: "mp4",
      elementaryStreams: ["video-stream0", "audio-stream0"],
    },
  ],
};

const hdConfig: GCP.Transcoder.JobConfig = {
  elementaryStreams: [
    {
      key: "video-stream0",
      videoStream: {
        h264: {
          heightPixels: 720,
          widthPixels: 1280,
          bitrateBps: 2500000,
          frameRate: 30,
        },
      },
    },
    {
      key: "audio-stream0",
      audioStream: { codec: "aac", bitrateBps: 64000 },
    },
  ],
  muxStreams: [
    {
      key: "hd",
      container: "mp4",
      elementaryStreams: ["video-stream0", "audio-stream0"],
    },
  ],
};

const waitUntilGone = (name: string) =>
  transcoder.getProjectsLocationsJobTemplates({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const probeAccess = () =>
  transcoder.getProjectsLocationsJobTemplates({ name: missingName }).pipe(
    Effect.as("ok" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("ok" as const)),
    Effect.catchTag("Forbidden", (error) => Effect.succeed(error)),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsJobTemplates on a missing template fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        transcoder.getProjectsLocationsJobTemplates({ name: missingName }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);
      if (error._tag === "Forbidden") {
        expect(error.message).toContain(DISABLED_MESSAGE);
      }

      const page = yield* transcoder
        .listProjectsLocationsJobTemplates({
          parent,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ jobTemplates: [] as const }),
          ),
        );
      expect(Array.isArray(page.jobTemplates ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, replace, and delete a job template",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* probeAccess();
      if (access !== "ok") {
        expect(access._tag).toEqual("Forbidden");
        expect(access.message).toContain(DISABLED_MESSAGE);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Transcoder.JobTemplate("WebHd", {
            location,
            labels: { env: "test" },
            config: sdConfig,
          });
        }),
      );

      expect(created.jobTemplateId).toEqual(expect.any(String));
      expect(created.jobTemplateId.length).toBeGreaterThanOrEqual(4);
      expect(created.name).toContain("/jobTemplates/");
      expect(created.location).toEqual(location);
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.config?.muxStreams?.[0]?.key).toEqual("sd");

      const fetched = yield* transcoder.getProjectsLocationsJobTemplates({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));
      expect(fetched.config?.muxStreams?.[0]?.key).toEqual("sd");

      const listed = yield* transcoder.listProjectsLocationsJobTemplates({
        parent: created.parent,
        pageSize: 1000,
      });
      expect(
        (listed.jobTemplates ?? []).some(
          (template) => template.name === created.name,
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Transcoder.JobTemplate("WebHd", {
            jobTemplateId: created.jobTemplateId,
            location,
            labels: { env: "prod", role: "transcode" },
            config: hdConfig,
          });
        }),
      );

      expect(updated.jobTemplateId).toEqual(created.jobTemplateId);
      expect(updated.location).toEqual(location);
      expect(updated.labels).toMatchObject({ env: "prod", role: "transcode" });
      expect(updated.config?.muxStreams?.[0]?.key).toEqual("hd");

      const fetchedUpdate = yield* transcoder.getProjectsLocationsJobTemplates({
        name: updated.name,
      });
      expect(fetchedUpdate.labels?.env).toEqual("prod");
      expect(fetchedUpdate.labels?.role).toEqual("transcode");
      expect(fetchedUpdate.config?.muxStreams?.[0]?.key).toEqual("hd");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Transcoder.JobTemplate("WebHd", {
            jobTemplateId: created.jobTemplateId,
            location: "us-east1",
            labels: { env: "test" },
            config: sdConfig,
          });
        }),
      );

      expect(replaced.jobTemplateId).toEqual(created.jobTemplateId);
      expect(replaced.location).toEqual("us-east1");
      expect(replaced.name).toContain("/locations/us-east1/");
      expect(replaced.name).not.toEqual(created.name);

      const oldGone = yield* waitUntilGone(updated.name);
      expect(oldGone).toEqual("gone");

      const fetchedReplace = yield* transcoder.getProjectsLocationsJobTemplates(
        {
          name: replaced.name,
        },
      );
      expect(fetchedReplace.name).toEqual(replaced.name);
      expect(fetchedReplace.config?.muxStreams?.[0]?.key).toEqual("sd");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
