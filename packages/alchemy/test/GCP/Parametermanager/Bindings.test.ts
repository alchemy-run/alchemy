import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

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

const JSON_PAYLOAD = JSON.stringify({ host: "api.example.com" });

test.provider.skipIf(!hasGcpCreds)(
  "GetParameter, GetParameterVersion, and RenderParameterVersion round-trip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const parameter = yield* GCP.Parametermanager.Parameter("AppConfig", {
            format: "JSON",
          });
          const version = yield* GCP.Parametermanager.ParametersVersion("V1", {
            parameter: parameter.name,
            data: JSON_PAYLOAD,
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* parameter.name;
              yield* version.name;
              const getParameter =
                yield* GCP.Parametermanager.GetParameter(parameter);
              const getVersion =
                yield* GCP.Parametermanager.GetParameterVersion(version);
              const render =
                yield* GCP.Parametermanager.RenderParameterVersion(version);
              return Effect.fn(function* () {
                const liveParameter = yield* getParameter();
                const liveVersion = yield* getVersion();
                const rendered = yield* render();
                return { liveParameter, liveVersion, rendered };
              });
            }),
          );
          return yield* Probe({});
        }),
      );

      expect(out.liveParameter.name).toContain("/parameters/");
      expect(out.liveParameter.format).toEqual("JSON");
      expect(out.liveVersion.name).toContain("/versions/");
      expect(out.liveVersion.payload?.data).toEqual(
        Buffer.from(JSON_PAYLOAD, "utf8").toString("base64"),
      );
      expect(
        out.rendered.renderedPayload ?? out.rendered.payload?.data,
      ).toEqual(expect.any(String));

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
