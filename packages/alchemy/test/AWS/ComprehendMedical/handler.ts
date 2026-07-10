import * as ComprehendMedical from "@/AWS/ComprehendMedical";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class ComprehendMedicalTestFunction extends Lambda.Function<Lambda.Function>()(
  "ComprehendMedicalTestFunction",
) {}

export default ComprehendMedicalTestFunction.make(
  {
    main,
    url: true,
    // Comprehend Medical inference can exceed Lambda's 3s default under load.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const detectEntities = yield* ComprehendMedical.DetectEntitiesV2();
    const detectPHI = yield* ComprehendMedical.DetectPHI();
    const inferICD10CM = yield* ComprehendMedical.InferICD10CM();

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        // Cheap readiness route — no Comprehend Medical call.
        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/entities") {
          const result = yield* detectEntities({
            Text: "Patient takes 50 mg atenolol daily for hypertension.",
          });
          return yield* HttpServerResponse.json({
            entities: (result.Entities ?? []).map((entity) => ({
              text: entity.Text,
              category: entity.Category,
              type: entity.Type,
            })),
            modelVersion: result.ModelVersion,
          });
        }

        if (request.method === "GET" && pathname === "/phi") {
          const result = yield* detectPHI({
            Text: "John Doe, age 47, was seen on 2024-01-03 at Seattle Clinic.",
          });
          return yield* HttpServerResponse.json({
            entities: (result.Entities ?? []).map((entity) => ({
              text: entity.Text,
              type: entity.Type,
            })),
          });
        }

        if (request.method === "GET" && pathname === "/icd10") {
          const result = yield* inferICD10CM({
            Text: "Patient presents with type 2 diabetes and hypertension.",
          });
          return yield* HttpServerResponse.json({
            entities: (result.Entities ?? []).map((entity) => ({
              text: entity.Text,
              codes: (entity.ICD10CMConcepts ?? []).map((concept) => ({
                code: concept.Code,
                description: concept.Description,
              })),
            })),
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ComprehendMedical.DetectEntitiesV2Http,
        ComprehendMedical.DetectPHIHttp,
        ComprehendMedical.InferICD10CMHttp,
      ),
    ),
  ),
);
