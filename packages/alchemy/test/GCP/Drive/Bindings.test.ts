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

const runLifecycle =
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_DRIVE;

test.provider.skipIf(!runLifecycle)(
  "GetFile round-trip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const file = yield* GCP.Drive.File("Notes", {
            name: "binding-notes",
            description: "from binding",
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* file.fileId;
              const getFile = yield* GCP.Drive.GetFile(file);
              return Effect.fn(function* () {
                return yield* getFile({});
              });
            }),
          );
          return { file, metadata: yield* Probe({}) };
        }),
      );

      expect(out.metadata.id).toEqual(out.file.fileId);
      expect(out.metadata.name).toEqual("binding-notes");
      expect(out.metadata.properties?.alchemy).toEqual("true");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
