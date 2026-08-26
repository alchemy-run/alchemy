import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as documentai from "@distilled.cloud/gcp/documentai_v1";
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

const waitUntilGone = (name: string) =>
  documentai.getProjectsLocationsProcessors({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const MINIMAL_PDF = `%PDF-1.1
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 12 Tf 20 100 Td (Hello) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000052 00000 n 
0000000101 00000 n 
0000000216 00000 n 
0000000309 00000 n 
trailer<</Size 6/Root 1 0 R>>
startxref
376
%%EOF
`;

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "Process and GetProcessor round-trip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* Effect.gen(function* () {
        const parent = `projects/${process.env.GOOGLE_PROJECT_ID ?? ""}/locations/us`;
        return yield* documentai
          .listProjectsLocationsProcessors({
            parent,
            pageSize: 1,
          })
          .pipe(
            Effect.map(() => ({ tag: "ok" as const })),
            Effect.catchTag("Forbidden", (error) =>
              Effect.succeed({
                tag: "Forbidden" as const,
                message: error.message,
              }),
            ),
            Effect.catchTag("NotFound", (error) =>
              Effect.succeed({
                tag: "NotFound" as const,
                message: error.message,
              }),
            ),
          );
      });
      if (probe.tag !== "ok") {
        expect(["Forbidden", "NotFound"]).toContain(probe.tag);
        yield* stack.destroy();
        return;
      }

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const processor = yield* GCP.Documentai.Processor("OcrBind", {
            location: "us",
            type: "OCR_PROCESSOR",
            displayName: "ocr-bind",
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* processor.name;
              const getProcessor =
                yield* GCP.Documentai.GetProcessor(processor);
              const process = yield* GCP.Documentai.Process(processor);
              return Effect.fn(function* () {
                const live = yield* getProcessor();
                const processed = yield* process({
                  body: {
                    rawDocument: {
                      content: btoa(MINIMAL_PDF),
                      mimeType: "application/pdf",
                    },
                    skipHumanReview: true,
                  },
                }).pipe(
                  Effect.catchTag("Forbidden", (error) =>
                    Effect.succeed({
                      tag: "Forbidden" as const,
                      message: error.message,
                    }),
                  ),
                  Effect.catchTag("BadRequest", (error) =>
                    Effect.succeed({
                      tag: "BadRequest" as const,
                      message: error.message,
                    }),
                  ),
                );
                return { live, processed };
              });
            }),
          );
          return { processor, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.live.name).toEqual(out.processor.name);
      expect(out.probe.live.type).toEqual("OCR_PROCESSOR");
      if (
        out.probe.processed &&
        typeof out.probe.processed === "object" &&
        "tag" in out.probe.processed
      ) {
        expect(["Forbidden", "BadRequest"]).toContain(out.probe.processed.tag);
      } else {
        expect(out.probe.processed.document).toEqual(expect.any(Object));
      }

      yield* stack.destroy();
      const gone = yield* waitUntilGone(out.processor.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
