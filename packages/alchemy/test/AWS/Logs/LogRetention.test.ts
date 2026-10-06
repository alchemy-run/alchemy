import * as Credentials from "@distilled.cloud/aws/Credentials";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { syncLogGroupRetention } from "@/AWS/Logs/LogRetention.ts";

/** A recorded CloudWatch Logs call: the operation name and its JSON body. */
interface LogsCall {
  operation: string;
  body: Record<string, unknown>;
}

/**
 * Offline CloudWatch Logs: an HTTP client that records each JSON-protocol
 * call and answers it with a fixed response, so the retention helper runs
 * through the real generated client without any AWS account.
 */
const fakeLogs = (calls: LogsCall[], respond: (operation: string) => Response) =>
  Layer.mergeAll(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          const target = request.headers["x-amz-target"] ?? "";
          const operation = target.split(".").pop() ?? target;
          const raw = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array();
          const text = new TextDecoder().decode(raw);
          calls.push({
            operation,
            body: text === "" ? {} : JSON.parse(text),
          });
          return HttpClientResponse.fromWeb(request, respond(operation));
        }),
      ),
    ),
    Layer.succeed(
      Credentials.Credentials,
      Effect.succeed({
        accessKeyId: Redacted.make("AKIAIOSFODNN7EXAMPLE"),
        secretAccessKey: Redacted.make("example-secret-access-key"),
        sessionToken: undefined,
        region: "us-east-1",
      }),
    ),
  );

const ok = () => Response.json({}, { headers: { "content-type": "application/x-amz-json-1.1" } });

const notFound = () =>
  Response.json(
    { __type: "ResourceNotFoundException", message: "The specified log group does not exist." },
    { status: 400, headers: { "content-type": "application/x-amz-json-1.1" } },
  );

describe("syncLogGroupRetention", { tags: ["unit", "local"] }, () => {
  it.effect("rounds a duration up to the nearest supported retention", () =>
    Effect.gen(function* () {
      const calls: LogsCall[] = [];
      yield* syncLogGroupRetention({
        logGroupName: "/aws/lambda/example",
        retention: "10 days",
      }).pipe(Effect.provide(fakeLogs(calls, ok)));
      expect(calls).toEqual([
        {
          operation: "PutRetentionPolicy",
          body: { logGroupName: "/aws/lambda/example", retentionInDays: 14 },
        },
      ]);
    }),
  );

  it.effect("clears the policy for `forever` and tolerates a missing group", () =>
    Effect.gen(function* () {
      const calls: LogsCall[] = [];
      yield* syncLogGroupRetention({
        logGroupName: "/aws/lambda/example",
        retention: "forever",
      }).pipe(Effect.provide(fakeLogs(calls, notFound)));
      expect(calls.map((c) => c.operation)).toEqual(["DeleteRetentionPolicy"]);
    }),
  );

  it.effect("control: leaves the group untouched when retention is unset", () =>
    Effect.gen(function* () {
      const calls: LogsCall[] = [];
      yield* syncLogGroupRetention({
        logGroupName: "/aws/lambda/example",
        retention: undefined,
      }).pipe(Effect.provide(fakeLogs(calls, ok)));
      expect(calls).toEqual([]);
    }),
  );
});
