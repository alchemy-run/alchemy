import * as Lambda from "@/AWS/Lambda";
import * as SQS from "@/AWS/SQS";
import * as StepFunctions from "@/AWS/StepFunctions";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

const plain = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : typeof value === "string"
      ? value
      : Redacted.value(value);

export class SFNTestFunction extends Lambda.Function<Lambda.Function>()(
  "SFNTestFunction",
) {}

export default SFNTestFunction.make(
  {
    main,
    url: true,
    // routes long-poll SQS and round-trip whole workflows — AWS's 3s
    // default intermittently times out under cold starts
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // EXPRESS workflow for synchronous invocation
    const express = yield* StepFunctions.StateMachine("TestExpressMachine", {
      type: "EXPRESS",
      definition: {
        StartAt: "Echo",
        States: {
          Echo: {
            Type: "Pass",
            Parameters: { "echo.$": "$", greeting: "hello" },
            End: true,
          },
        },
      },
    });

    // STANDARD workflow for async start + describe polling
    const standard = yield* StepFunctions.StateMachine("TestStandardMachine", {
      definition: {
        StartAt: "Done",
        States: {
          Done: { Type: "Pass", Result: { done: true }, End: true },
        },
      },
    });

    // Callback-pattern workflow: parks on .waitForTaskToken after sending
    // the task token to an SQS queue.
    const callbackQueue = yield* SQS.Queue("CallbackQueue");
    const callback = yield* StepFunctions.StateMachine("TestCallbackMachine", {
      definition: {
        StartAt: "WaitForCallback",
        States: {
          WaitForCallback: {
            Type: "Task",
            Resource: "arn:aws:states:::sqs:sendMessage.waitForTaskToken",
            Parameters: {
              QueueUrl: callbackQueue.queueUrl,
              MessageBody: {
                "token.$": "$$.Task.Token",
                "executionArn.$": "$$.Execution.Id",
              },
            },
            TimeoutSeconds: 300,
            End: true,
          },
        },
      },
      policyStatements: [
        {
          Effect: "Allow",
          Action: ["sqs:SendMessage"],
          Resource: [callbackQueue.queueArn],
        },
      ],
    });

    const startSyncExecution = yield* StepFunctions.StartSyncExecution(express);
    const startExecution = yield* StepFunctions.StartExecution(standard);
    const startCallbackExecution =
      yield* StepFunctions.StartExecution(callback);
    const describeStandardExecution =
      yield* StepFunctions.DescribeExecution(standard);
    const describeCallbackExecution =
      yield* StepFunctions.DescribeExecution(callback);
    const stopExecution = yield* StepFunctions.StopExecution(callback);
    const sendTaskSuccess = yield* StepFunctions.SendTaskSuccess();
    const sendTaskFailure = yield* StepFunctions.SendTaskFailure();
    const sendTaskHeartbeat = yield* StepFunctions.SendTaskHeartbeat();
    const validateDefinition =
      yield* StepFunctions.ValidateStateMachineDefinition();
    const testState = yield* StepFunctions.TestState();
    const receiveMessage = yield* SQS.ReceiveMessage(callbackQueue);
    const deleteMessage = yield* SQS.DeleteMessage(callbackQueue);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/health") {
          return HttpServerResponse.text("ok");
        }

        if (request.method === "POST" && pathname === "/start-sync") {
          const body = (yield* request.json) as unknown as { input?: string };
          const result = yield* startSyncExecution({ input: body.input });
          return yield* HttpServerResponse.json({
            executionArn: result.executionArn,
            status: result.status,
            output: plain(result.output),
            error: plain(result.error),
            cause: plain(result.cause),
          });
        }

        if (request.method === "POST" && pathname === "/start") {
          const body = (yield* request.json) as unknown as { input?: string };
          const result = yield* startExecution({ input: body.input });
          return yield* HttpServerResponse.json({
            executionArn: result.executionArn,
          });
        }

        if (request.method === "POST" && pathname === "/start-callback") {
          const result = yield* startCallbackExecution();
          return yield* HttpServerResponse.json({
            executionArn: result.executionArn,
          });
        }

        if (request.method === "GET" && pathname === "/describe-standard") {
          const executionArn = url.searchParams.get("executionArn")!;
          const result = yield* describeStandardExecution({ executionArn });
          return yield* HttpServerResponse.json({
            status: result.status,
            output: plain(result.output),
          });
        }

        if (request.method === "GET" && pathname === "/describe-callback") {
          const executionArn = url.searchParams.get("executionArn")!;
          const result = yield* describeCallbackExecution({ executionArn });
          return yield* HttpServerResponse.json({
            status: result.status,
            output: plain(result.output),
            error: plain(result.error),
          });
        }

        if (request.method === "GET" && pathname === "/receive-token") {
          const result = yield* receiveMessage({
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 5,
            // resurface quickly if a failed invocation consumed the message
            VisibilityTimeout: 15,
          });
          const message = result.Messages?.[0];
          if (!message?.Body) {
            return yield* HttpServerResponse.json({ token: null });
          }
          yield* deleteMessage({ ReceiptHandle: message.ReceiptHandle! });
          const parsed = JSON.parse(message.Body) as {
            token: string;
            executionArn: string;
          };
          return yield* HttpServerResponse.json({
            token: parsed.token,
            executionArn: parsed.executionArn,
          });
        }

        if (request.method === "POST" && pathname === "/task-success") {
          const body = (yield* request.json) as unknown as {
            token: string;
            output: string;
          };
          yield* sendTaskSuccess({
            taskToken: body.token,
            output: body.output,
          });
          return yield* HttpServerResponse.json({ sent: true });
        }

        if (request.method === "POST" && pathname === "/task-failure") {
          const body = (yield* request.json) as unknown as {
            token: string;
            error?: string;
            cause?: string;
          };
          yield* sendTaskFailure({
            taskToken: body.token,
            error: body.error,
            cause: body.cause,
          });
          return yield* HttpServerResponse.json({ sent: true });
        }

        if (request.method === "POST" && pathname === "/task-heartbeat") {
          const body = (yield* request.json) as unknown as { token: string };
          yield* sendTaskHeartbeat({ taskToken: body.token });
          return yield* HttpServerResponse.json({ sent: true });
        }

        if (request.method === "POST" && pathname === "/validate-definition") {
          const body = (yield* request.json) as unknown as {
            definition: string;
            type?: "STANDARD" | "EXPRESS";
          };
          const report = yield* validateDefinition({
            definition: body.definition,
            type: body.type,
            severity: "ERROR",
          });
          return yield* HttpServerResponse.json({
            result: report.result,
            diagnostics: report.diagnostics.map((diagnostic) => ({
              severity: diagnostic.severity,
              code: plain(diagnostic.code),
              message: plain(diagnostic.message),
            })),
          });
        }

        if (request.method === "POST" && pathname === "/test-state") {
          const body = (yield* request.json) as unknown as {
            definition: string;
            input?: string;
          };
          const result = yield* testState({
            definition: body.definition,
            input: body.input,
          });
          return yield* HttpServerResponse.json({
            status: result.status,
            output: plain(result.output),
            error: plain(result.error),
          });
        }

        if (request.method === "POST" && pathname === "/stop") {
          const body = (yield* request.json) as unknown as {
            executionArn: string;
          };
          const result = yield* stopExecution({
            executionArn: body.executionArn,
            error: "TestStop",
            cause: "stopped by integration test",
          });
          return yield* HttpServerResponse.json({
            stopDate: result.stopDate.toISOString(),
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
        StepFunctions.StartExecutionHttp,
        StepFunctions.StartSyncExecutionHttp,
        StepFunctions.DescribeExecutionHttp,
        StepFunctions.StopExecutionHttp,
        StepFunctions.SendTaskSuccessHttp,
        StepFunctions.SendTaskFailureHttp,
        StepFunctions.SendTaskHeartbeatHttp,
        StepFunctions.ValidateStateMachineDefinitionHttp,
        StepFunctions.TestStateHttp,
        SQS.ReceiveMessageHttp,
        SQS.DeleteMessageHttp,
      ),
    ),
  ),
);
