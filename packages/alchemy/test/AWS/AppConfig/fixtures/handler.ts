import * as AppConfig from "@/AWS/AppConfig";
import * as Lambda from "@/AWS/Lambda";
import * as Output from "@/Output";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

const CONFIG = { featureX: true, limit: 42 } as const;

export class AppConfigTestFunction extends Lambda.Function<Lambda.Function>()(
  "AppConfigTestFunction",
) {}

export default AppConfigTestFunction.make(
  {
    main,
    url: true,
    // Starting a configuration session + fetching config fans out two SDK
    // calls; AWS's 3s default intermittently times out on a cold start.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const app = yield* AppConfig.Application("App", {});
    const env = yield* AppConfig.Environment("Env", {
      applicationId: app.applicationId,
    });
    const profile = yield* AppConfig.ConfigurationProfile("Profile", {
      applicationId: app.applicationId,
      locationUri: "hosted",
    });
    const version = yield* AppConfig.HostedConfigurationVersion("V1", {
      applicationId: app.applicationId,
      configurationProfileId: profile.configurationProfileId,
      content: JSON.stringify(CONFIG),
      contentType: "application/json",
    });
    const strategy = yield* AppConfig.DeploymentStrategy("AllAtOnce", {
      deploymentDurationInMinutes: 0,
      growthFactor: 100,
      finalBakeTimeInMinutes: 0,
      replicateTo: "NONE",
    });
    // Deploy the version to the environment so the data plane can serve it.
    yield* AppConfig.Deployment("Deploy", {
      applicationId: app.applicationId,
      environmentId: env.environmentId,
      deploymentStrategyId: strategy.deploymentStrategyId,
      configurationProfileId: profile.configurationProfileId,
      configurationVersion: Output.interpolate`${version.versionNumber}`,
    });

    const getConfig = yield* AppConfig.GetConfiguration(app, env, profile);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        if (request.method === "GET" && pathname === "/config") {
          const result = yield* getConfig();
          return yield* HttpServerResponse.json({
            content: result.content,
            contentType: result.contentType,
          });
        }

        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(AppConfig.GetConfigurationHttp)),
);
