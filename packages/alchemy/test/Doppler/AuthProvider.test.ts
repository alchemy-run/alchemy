import { expect, it } from "alchemy-test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as PlatformError from "effect/PlatformError";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import { AuthProviders, getAuthProvider } from "@/Auth/AuthProvider.ts";
import {
  DopplerAuth,
  login,
  type DopplerAuthConfig,
  type DopplerResolvedCredentials,
} from "@/Doppler/AuthProvider.ts";
import { Interaction } from "@/Interaction.ts";

const interaction: Interaction["Service"] = {
  output: {
    info: () => Effect.void,
    success: () => Effect.void,
    warning: () => Effect.void,
    error: () => Effect.void,
  },
  prompt: {
    text: () => Effect.die("Unexpected text prompt"),
    password: () => Effect.succeed("api-token"),
    select: () => Effect.die("Unexpected select prompt"),
    confirm: () => Effect.die("Unexpected confirm prompt"),
    multiSelect: () => Effect.die("Unexpected multiSelect prompt"),
    awaitExternal: (options) => {
      expect(options.allowManualInput).toBe(false);
      expect(options.code).toBe("ABCD");
      return Effect.never;
    },
  },
  task: (_, effect) => effect,
};

const browser = ChildProcessSpawner.make(() =>
  Effect.fail(
    PlatformError.systemError({
      _tag: "NotFound",
      module: "ChildProcess",
      method: "spawn",
      description: "No browser in test",
    }),
  ),
);

for (const outcome of ["success", "pending", "rejected"] as const) {
  it.effect(
    `explicit login handles ${outcome} and only retries pending approval`,
    () => {
      let polls = 0;
      return Effect.gen(function* () {
        const fiber = yield* login.pipe(Effect.result, Effect.forkScoped);
        yield* TestClock.adjust(
          outcome === "pending" ? "5 minutes" : "3 seconds",
        );
        const result = yield* Fiber.join(fiber);
        if (outcome === "success") {
          expect(Result.isSuccess(result)).toBe(true);
          if (Result.isSuccess(result))
            expect(result.success).toEqual({
              method: "login",
              token: "issued-token",
            });
          expect(polls).toBe(2);
        } else {
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result))
            expect(result.failure.message).toContain("login did not complete");
          expect(polls).toBe(outcome === "rejected" ? 1 : 150);
        }
      }).pipe(
        Effect.provideService(Interaction, interaction),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, browser),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              const url = new URL(request.url);
              expect(request.headers.authorization).toBeUndefined();
              if (url.pathname === "/v3/auth/cli/generate/2") {
                expect(url.searchParams.get("version")).toMatch(
                  /^v\d+\.\d+\.\d+$/,
                );
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({
                    code: "ABCD",
                    polling_code: "poll-secret",
                    auth_url: "https://dashboard.doppler.com/auth/cli",
                  }),
                );
              }
              expect(url.pathname).toBe("/v3/auth/cli/authorize");
              polls++;
              return HttpClientResponse.fromWeb(
                request,
                outcome === "success" && polls === 2
                  ? Response.json({
                      token: "issued-token",
                      name: "Alchemy",
                      dashboard_url: "https://dashboard.doppler.com",
                    })
                  : Response.json(
                      { messages: ["pending or rejected"] },
                      { status: outcome === "rejected" ? 400 : 409 },
                    ),
              );
            }),
          ),
        ),
        Effect.scoped,
      );
    },
  );
}

it.effect(
  "API token configuration and logout do not make network requests or open a browser",
  () =>
    Effect.gen(function* () {
      const auth = yield* getAuthProvider<
        DopplerAuthConfig,
        DopplerResolvedCredentials
      >("Doppler");
      const config = yield* auth.configureWith!("doppler-test", {
        method: "api-token",
        values: { token: "stored-token" },
      });
      expect(config).toEqual({ method: "api-token", token: "stored-token" });
      yield* auth.logout("doppler-test", config);
      const invalid = yield* auth.configureWith!("doppler-test", {
        method: "login",
        values: {},
      }).pipe(Effect.result);
      expect(Result.isFailure(invalid)).toBe(true);
    }).pipe(
      Effect.provide(DopplerAuth),
      Effect.provideService(AuthProviders, {}),
      Effect.provideService(Interaction, interaction),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("No network expected")),
      ),
      Effect.provide(NodeServices.layer),
    ),
);
