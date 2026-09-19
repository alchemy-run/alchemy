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

test.provider.skipIf(!hasGcpCreds)(
  "ListDockerImages on an empty repository",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const page = yield* stack.deploy(
        Effect.gen(function* () {
          const repository = yield* GCP.ArtifactRegistry.Repository("Images", {
            location: "us-central1",
            format: "DOCKER",
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* repository.name;
              const listImages =
                yield* GCP.ArtifactRegistry.ListDockerImages(repository);
              return Effect.fn(function* () {
                return yield* listImages({ pageSize: 10 });
              });
            }),
          );
          return yield* Probe({});
        }),
      );

      expect(Array.isArray(page.dockerImages ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
