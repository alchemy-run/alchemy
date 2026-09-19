import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as drivelabels from "@distilled.cloud/gcp/drivelabels_v2";
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

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "GetLabel round-trip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* drivelabels
        .createLabels({
          body: {
            labelType: "SHARED",
            properties: { title: "Alchemy Drive Labels Binding Probe" },
          },
        })
        .pipe(
          Effect.map((label) => ({ ok: true as const, label })),
          Effect.catchTag(["Forbidden", "NotFound", "BadRequest"], (error) =>
            Effect.succeed({ ok: false as const, error: error._tag }),
          ),
        );
      if (!access.ok) {
        expect(["Forbidden", "NotFound", "BadRequest"]).toContain(access.error);
        yield* stack.destroy();
        return;
      }
      const probeName =
        access.label.name ??
        (access.label.id ? `labels/${access.label.id}` : "");
      if (probeName.length > 0) {
        yield* drivelabels
          .deleteLabels({ name: probeName })
          .pipe(
            Effect.catchTag(
              ["NotFound", "Forbidden", "BadRequest", "Conflict"],
              () => Effect.void,
            ),
          );
      }

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const label = yield* GCP.Drivelabels.Label("Classification", {
            title: "BindingLabel",
            description: "from binding",
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* label.name;
              const getLabel = yield* GCP.Drivelabels.GetLabel(label);
              return Effect.fn(function* () {
                return yield* getLabel({ view: "LABEL_VIEW_FULL" });
              });
            }),
          );
          return { label, metadata: yield* Probe({}) };
        }),
      );

      expect(out.metadata.id).toEqual(out.label.labelId);
      expect(out.metadata.name).toEqual(out.label.name);
      expect(out.metadata.properties?.title).toEqual("BindingLabel");
      expect(out.metadata.properties?.description).toContain("[alchemy ");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
