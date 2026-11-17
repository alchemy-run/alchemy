import { PrismaApiError } from "@alchemy.run/prisma/Client";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Credentials } from "../../../prisma/src/internal/Credentials.ts";
import {
  getBuildLogsRequest,
  getDeploymentLogsRequest,
} from "../../../prisma/src/internal/LogsClient.ts";

const provideEnv = Effect.provideService(
  Credentials,
  Effect.succeed({ apiToken: Redacted.make("test-token"), apiBaseUrl: "https://api.prisma.test" }),
);

describe("Prisma log request builders", { tags: ["unit", "provider:prisma", "local"] }, () => {
  it.effect("builds authenticated deployment log stream requests", () =>
    Effect.gen(function* () {
      const request = yield* getDeploymentLogsRequest("deployment-1", {
        tail: 100,
        fromStart: true,
        cursor: "byte-42",
      });
      expect(request.url).toBe(
        "wss://api.prisma.test/v1/deployments/deployment-1/logs?tail=100&cursor=byte-42&from_start=true",
      );
      expect(request.headers.Authorization && Redacted.value(request.headers.Authorization)).toBe(
        "Bearer test-token",
      );
    }).pipe(provideEnv),
  );

  it.effect("builds authenticated build log stream requests", () =>
    Effect.gen(function* () {
      const request = yield* getBuildLogsRequest("build-1", { follow: true, cursor: "cursor-1" });
      expect(request.url).toBe(
        "https://api.prisma.test/v1/builds/build-1/logs?follow=true&cursor=cursor-1",
      );
      expect(request.headers.Authorization && Redacted.value(request.headers.Authorization)).toBe(
        "Bearer test-token",
      );
      expect(request.headers.Accept).toBe("application/x-ndjson");
    }).pipe(provideEnv),
  );

  it.effect("fails log requests with a ConfigError when the credentials have no token", () =>
    Effect.gen(function* () {
      const deploymentLog = yield* getDeploymentLogsRequest("deployment-1").pipe(Effect.flip);
      const buildLog = yield* getBuildLogsRequest("build-1").pipe(Effect.flip);
      for (const error of [deploymentLog, buildLog]) {
        expect(error._tag).toBe("ConfigError");
      }
    }).pipe(
      Effect.provideService(Credentials, Effect.succeed({ apiBaseUrl: "https://api.prisma.test" })),
    ),
  );

  it.effect("rejects path-confusing resource IDs before building a URL", () =>
    Effect.gen(function* () {
      const deploymentLog = yield* getDeploymentLogsRequest("deployment-1/../../projects").pipe(
        Effect.flip,
      );
      const buildLog = yield* getBuildLogsRequest("build-1?token=leak").pipe(Effect.flip);

      for (const error of [deploymentLog, buildLog]) {
        expect(error).toBeInstanceOf(PrismaApiError);
        expect(error.message).toContain("invalid Prisma Management API");
      }
    }).pipe(provideEnv),
  );
});
