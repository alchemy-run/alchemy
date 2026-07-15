import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Vitest";
import * as mediatailor from "@distilled.cloud/aws/mediatailor";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { describe } from "vitest";

import MediaTailorTestFunctionLive, {
  MediaTailorTestFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "MediaTailorBindings");

const PREFETCH_NAME = "alchemy-test-prefetch-schedule";

let baseUrl: string;
let configName: string;
let configArn: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx (cold
// re-init, IAM propagation on the freshly attached policy). Retry only 5xx.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("1 second"),
        Schedule.recurs(8),
      ]),
    }),
  );

const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

const postJson = (path: string, body: object) =>
  send(
    HttpClientRequest.post(`${baseUrl}${path}`).pipe(
      HttpClientRequest.bodyJsonUnsafe(body),
    ),
  ).pipe(Effect.flatMap((r) => r.json));

describe.sequential("MediaTailor Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "MediaTailor test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("MediaTailor test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* MediaTailorTestFunction;
        }).pipe(Effect.provide(MediaTailorTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      // Out-of-band: find the playback configuration the fixture deployed
      // (its physical name is generated) by its alchemy ownership tags.
      const configs = yield* mediatailor.listPlaybackConfigurations
        .items({})
        .pipe(Stream.runCollect);
      const config = Array.from(configs).find(
        (candidate) =>
          candidate.Tags?.["alchemy::id"] === "BindingsConfig" &&
          candidate.Tags?.["alchemy::stack"] === "MediaTailorBindings",
      );
      expect(config).toBeDefined();
      configName = config!.Name!;
      configArn = config!.PlaybackConfigurationArn!;

      // Readiness probe — fresh function URLs take seconds (sometimes over a
      // minute) to serve 200s.
      yield* HttpClient.get(`${baseUrl}/health`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.fixed("2 seconds"),
            Schedule.recurs(75),
          ]),
        }),
      );
    }),
    { timeout: 300_000 },
  );
  afterAll(sharedStack.destroy(), { timeout: 300_000 });

  describe("CreatePrefetchSchedule + GetPrefetchSchedule + ListPrefetchSchedules + DeletePrefetchSchedule", () => {
    test.provider(
      "full prefetch-schedule lifecycle against the deployed configuration",
      () =>
        Effect.gen(function* () {
          // create
          const created = (yield* postJson("/prefetch/create", {
            name: PREFETCH_NAME,
          })) as { arn?: string; error?: string };
          expect(created.error).toBeUndefined();
          expect(created.arn).toContain(":prefetchSchedule/");

          // out-of-band verification via distilled
          const fetched = yield* mediatailor.getPrefetchSchedule({
            Name: PREFETCH_NAME,
            PlaybackConfigurationName: configName,
          });
          expect(fetched.Name).toBe(PREFETCH_NAME);

          // get through the binding
          const got = (yield* getJson(
            `/prefetch/get?name=${PREFETCH_NAME}`,
          )) as { name?: string; error?: string };
          expect(got.error).toBeUndefined();
          expect(got.name).toBe(PREFETCH_NAME);

          // list through the binding
          const listed = (yield* getJson("/prefetch/list")) as {
            names: string[];
            error?: string;
          };
          expect(listed.error).toBeUndefined();
          expect(listed.names).toContain(PREFETCH_NAME);

          // delete through the binding
          const deleted = (yield* postJson("/prefetch/delete", {
            name: PREFETCH_NAME,
          })) as { deleted: boolean; error?: string };
          expect(deleted.error).toBeUndefined();
          expect(deleted.deleted).toBe(true);

          // get after delete surfaces the typed synthetic tag
          const gone = (yield* getJson(
            `/prefetch/get?name=${PREFETCH_NAME}`,
          )) as { name?: string; error?: string };
          expect(gone.error).toBe("PrefetchScheduleNotFound");
        }),
      { timeout: 120_000 },
    );
  });

  describe("ListAlerts", () => {
    test.provider(
      "lists alerts for the configuration ARN from the runtime",
      () =>
        Effect.gen(function* () {
          const body = (yield* getJson(
            `/alerts?arn=${encodeURIComponent(configArn)}`,
          )) as { count: number; error?: string };
          expect(body.error).toBeUndefined();
          expect(typeof body.count).toBe("number");
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetChannelSchedule", () => {
    test.provider(
      "returns the typed ChannelNotFound for a missing channel",
      () =>
        Effect.gen(function* () {
          const body = (yield* getJson(
            "/channel/schedule?name=alchemy-nonexistent-mediatailor-channel",
          )) as { count: number; error?: string };
          // A typed not-found (never AccessDenied) proves the
          // mediatailor:GetChannelSchedule grant reached the API.
          expect(body.error).toBe("ChannelNotFound");
        }),
      { timeout: 60_000 },
    );
  });

  describe("StartChannel + StopChannel", () => {
    test.provider(
      "start/stop of a missing channel fail with typed tags (never AccessDenied)",
      () =>
        Effect.gen(function* () {
          const started = (yield* postJson("/channel/start", {
            name: "alchemy-nonexistent-mediatailor-channel",
          })) as { started: boolean; error?: string };
          expect(started.started).toBe(false);
          expect(["ChannelNotFound", "BadRequestException"]).toContain(
            started.error,
          );

          const stopped = (yield* postJson("/channel/stop", {
            name: "alchemy-nonexistent-mediatailor-channel",
          })) as { stopped: boolean; error?: string };
          expect(stopped.stopped).toBe(false);
          expect(["ChannelNotFound", "BadRequestException"]).toContain(
            stopped.error,
          );
        }),
      { timeout: 60_000 },
    );
  });

  describe("CreateProgram + DescribeProgram + UpdateProgram + DeleteProgram", () => {
    test.provider(
      "program operations on a missing channel fail with typed tags (never AccessDenied)",
      () =>
        Effect.gen(function* () {
          const created = (yield* postJson("/program/create", {})) as {
            created: boolean;
            error?: string;
          };
          expect(created.created).toBe(false);
          expect(["ChannelNotFound", "BadRequestException"]).toContain(
            created.error,
          );

          const described = (yield* getJson("/program")) as {
            name?: string;
            error?: string;
          };
          expect(described.name).toBeUndefined();
          expect(["ProgramNotFound", "BadRequestException"]).toContain(
            described.error,
          );

          const updated = (yield* postJson("/program/update", {})) as {
            updated: boolean;
            error?: string;
          };
          expect(updated.updated).toBe(false);
          expect(["ProgramNotFound", "BadRequestException"]).toContain(
            updated.error,
          );

          const deleted = (yield* postJson("/program/delete", {})) as {
            deleted: boolean;
            error?: string;
          };
          expect(deleted.deleted).toBe(false);
          expect(["ProgramNotFound", "BadRequestException"]).toContain(
            deleted.error,
          );
        }),
      { timeout: 60_000 },
    );
  });
});
