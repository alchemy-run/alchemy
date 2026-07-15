import * as BDA from "@/AWS/BedrockDataAutomation";
import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

const INPUT_KEY = "inputs/hello.pdf";

// Minimal single-page PDF, checked in as a constant (never generated at test
// time). The async invoke only needs a readable S3 object — the job's final
// verdict is irrelevant to the binding test.
const TINY_PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>endobj
4 0 obj<</Length 46>>stream
BT /F1 24 Tf 72 720 Td (Hello Alchemy) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Size 6/Root 1 0 R>>
%%EOF
`;

export class BdaTestFunction extends Lambda.Function<Lambda.Function>()(
  "BdaTestFunction",
) {}

export default BdaTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const project = yield* BDA.DataAutomationProject("BindingsProject", {
      projectDescription: "alchemy bindings test project",
      standardOutputConfiguration: {
        document: {
          extraction: {
            granularity: { types: ["DOCUMENT"] },
            boundingBox: { state: "DISABLED" },
          },
          generativeField: { state: "DISABLED" },
          outputFormat: {
            textFormat: { types: ["MARKDOWN"] },
            additionalFileFormat: { state: "DISABLED" },
          },
        },
      },
    });
    // Bedrock Data Automation reads the input and writes the output with the
    // CALLER's S3 permissions (forward access sessions), so the Lambda role
    // needs GetObject + PutObject on the working bucket.
    const bucket = yield* S3.Bucket("BindingsBucket", { forceDestroy: true });
    const bucketName = yield* bucket.bucketName;

    const putObject = yield* S3.PutObject(bucket);
    const getObject = yield* S3.GetObject(bucket);
    const invokeDataAutomationAsync =
      yield* BDA.InvokeDataAutomationAsync(project);
    const invokeDataAutomation = yield* BDA.InvokeDataAutomation(project);
    const getDataAutomationStatus = yield* BDA.GetDataAutomationStatus();

    // Deploy-time: creates the EventBridge rule (default bus, source
    // aws.bedrock) targeting this Function. Runtime firing needs a settled
    // job with eventBridgeEnabled, so the test only verifies the
    // subscription deploys.
    yield* BDA.consumeDataAutomationJobEvents(
      { kinds: ["succeeded", "client-error", "service-error"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `data automation job ${event.detail.job_id}: ${event.detail.job_status}`,
          ),
        ),
    );

    const bound = {
      putObject,
      getObject,
      invokeDataAutomationAsync,
      invokeDataAutomation,
      getDataAutomationStatus,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "POST" && pathname === "/invoke-async") {
          // Uploads the fixture document, then submits an async job against
          // the bound project. The response arrives before the job settles —
          // the test asserts the invocation ARN shape and polls status once.
          const profileArn = url.searchParams.get("profileArn")!;
          // Double-yield: the init-scope yield gives an accessor; yielding
          // it here resolves the physical bucket name at runtime.
          const physicalBucket = yield* bucketName;
          const result = yield* putObject({
            Key: INPUT_KEY,
            Body: TINY_PDF,
            ContentType: "application/pdf",
          }).pipe(
            Effect.flatMap(() =>
              invokeDataAutomationAsync({
                inputConfiguration: {
                  s3Uri: `s3://${physicalBucket}/${INPUT_KEY}`,
                },
                outputConfiguration: {
                  s3Uri: `s3://${physicalBucket}/results/`,
                },
                dataAutomationProfileArn: profileArn,
                notificationConfiguration: {
                  eventBridgeConfiguration: { eventBridgeEnabled: true },
                },
              }),
            ),
            Effect.map((r) => ({ invocationArn: r.invocationArn })),
            // Surface the typed failure to the test instead of a bare 500 —
            // the assertion prints the tag + message on mismatch.
            Effect.catch((e) =>
              Effect.succeed({
                invocationArn: undefined,
                error: e._tag,
                message: String((e as { message?: unknown }).message ?? ""),
              }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/status") {
          const invocationArn = url.searchParams.get("invocationArn")!;
          const result = yield* getDataAutomationStatus({ invocationArn });
          return yield* HttpServerResponse.json({ status: result.status });
        }

        if (
          request.method === "POST" &&
          pathname === "/invoke-sync-validation"
        ) {
          // The sync API needs a SYNC project and a non-empty input; driving
          // it through the typed ValidationException path proves the IAM
          // grant + project injection end-to-end — an IAM gap would surface
          // AccessDeniedException (a 500 through orDie) instead.
          const profileArn = url.searchParams.get("profileArn")!;
          const tag = yield* invokeDataAutomation({
            inputConfiguration: {},
            dataAutomationProfileArn: profileArn,
          }).pipe(
            Effect.map(() => "Invoked"),
            Effect.catchTag("ValidationException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
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
        Lambda.EventSource,
        S3.PutObjectHttp,
        S3.GetObjectHttp,
        BDA.InvokeDataAutomationAsyncHttp,
        BDA.InvokeDataAutomationHttp,
        BDA.GetDataAutomationStatusHttp,
      ),
    ),
  ),
);
