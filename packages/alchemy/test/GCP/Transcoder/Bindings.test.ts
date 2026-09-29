import { GcpEnvironment } from "@/GCP/Environment";
import { Action } from "@/Action";
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
const location = "us-central1";
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

const waitUntilGone = (name: string) =>
  transcoder.getProjectsLocationsJobs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!!process.env.FAST)(
  "CreateJob starts a job from a template",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const missingName = `projects/${project}/locations/${location}/jobTemplates/alchemy-missing-template`;

      yield* stack.destroy();

      const access = yield* transcoder
        .getProjectsLocationsJobTemplates({ name: missingName })
        .pipe(
          Effect.as("ok" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("ok" as const)),
          Effect.catchTag("Forbidden", (error) => Effect.succeed(error)),
        );
      if (access !== "ok") {
        expect(access._tag).toEqual("Forbidden");
        expect(access.message).toContain(DISABLED_MESSAGE);
        yield* stack.destroy();
        return;
      }

      const started = yield* stack.deploy(
        Effect.gen(function* () {
          const input = yield* GCP.Storage.Bucket("In", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          const output = yield* GCP.Storage.Bucket("Out", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          const template = yield* GCP.Transcoder.JobTemplate("WebHd", {
            location,
            config: sdConfig,
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* template.name;
              const inputName = yield* input.bucketName;
              const outputName = yield* output.bucketName;
              const createJob = yield* GCP.Transcoder.CreateJob(template);
              return Effect.fn(function* () {
                return yield* createJob({
                  body: {
                    inputUri: `gs://${inputName}/inputs/file.mp4`,
                    outputUri: `gs://${outputName}/outputs/`,
                    ttlAfterCompletionDays: 1,
                  },
                });
              });
            }),
          );
          return yield* Probe({});
        }),
      );

      expect(started.name).toContain("/jobs/");
      expect(started.templateId ?? started.config).toBeDefined();

      yield* transcoder
        .deleteProjectsLocationsJobs({
          name: started.name ?? "",
          allowMissing: true,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      if (started.name) {
        const gone = yield* waitUntilGone(started.name);
        expect(gone).toEqual("gone");
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
