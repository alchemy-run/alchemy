import { Credentials, fromEnv } from "@distilled.cloud/aws/Credentials";
import * as LambdaSdk from "@distilled.cloud/aws/lambda";
import { Retry } from "@distilled.cloud/aws/Retry";
import * as Runtime from "@distilled.cloud/celld/runtime";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { Function as LambdaFunction } from "../AWS/Lambda/Function.ts";
import type { InputProps } from "../Input.ts";
import * as Output from "../Output.ts";
import { FleetStorageError } from "./FleetStorage.ts";
import { makeS3Store } from "./FleetStorageS3.ts";
import type { FleetConnection } from "./Host.ts";
import {
  ActivateEvidence,
  FleetManagement,
  FleetManagementError,
  ManagementGraph,
  ReloadEvidence,
  makeLocalFleetManagement,
  type FleetManagementService,
  type ManagementOptions,
} from "./Management.ts";
import { OperatorError } from "./OperatorClient.ts";

const Operations = Schema.Literals([
  "reload",
  "activate",
  "execD1",
  "executeD1Statements",
  "migrateD1",
]);
const Request = Schema.Struct({
  version: Schema.Literal(1),
  bucket: Schema.String,
  operation: Operations,
  input: Schema.Unknown,
});
const Failure = Schema.Struct({
  reason: Schema.Literals([
    "configuration",
    "discovery",
    "transport",
    "drift",
    "membership-changed",
    "reload-failed",
    "state-unavailable",
    "swap-pending",
    "unobservable",
  ]),
  message: Schema.String,
  evidence: Schema.optional(ReloadEvidence),
});
const Response = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
  Schema.Struct({ ok: Schema.Literal(false), error: Failure }),
]);
export type ManagementRunnerResponse = typeof Response.Type;

const encode = (value: unknown) =>
  Effect.try({
    try: () => {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      if (bytes.length > 1024 * 1024)
        throw new Error("Management payload too large");
      return bytes;
    },
    catch: () =>
      new FleetManagementError({
        reason: "configuration",
        message: "Invalid or oversized private Celld management payload.",
      }),
  });
const decode = <A>(schema: Schema.Schema<A>, value: unknown) =>
  Schema.decodeUnknownEffect(Schema.toType(schema))(value).pipe(
    Effect.mapError(
      () =>
        new FleetManagementError({
          reason: "configuration",
          message: "Invalid private Celld management protocol message.",
        }),
    ),
  );
const parse = (body: Uint8Array) =>
  Effect.try({
    try: () =>
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
    catch: () =>
      new FleetManagementError({
        reason: "transport",
        message: "Invalid private Celld management response.",
      }),
  });

/** Validate the wire event before selecting any operation. Connection material is runner-owned. */
export const handleManagementRequest = (
  event: unknown,
  connection: FleetConnection,
  management: FleetManagementService,
): Effect.Effect<ManagementRunnerResponse> =>
  Effect.gen(function* () {
    yield* encode(event);
    const request = yield* decode(Request, event);
    if (!connection.bucket || request.bucket !== connection.bucket.uri)
      return yield* Effect.fail(
        new FleetManagementError({
          reason: "configuration",
          message: "Management runner is bound to a different fleet bucket.",
        }),
      );
    if (request.operation === "reload" || request.operation === "activate") {
      const graph = yield* decode(ManagementGraph, request.input);
      const value =
        request.operation === "activate"
          ? yield* decode(
              ActivateEvidence,
              yield* management.activate(connection, graph),
            )
          : yield* decode(
              ReloadEvidence,
              yield* management.reload(connection, graph),
            );
      return { ok: true, value } as const;
    }
    const input = yield* decode(
      Schema.Record(Schema.String, Schema.Unknown),
      request.input,
    );
    const unsigned = {
      ...input,
      peer_version: "",
      peer_source: "",
      peer_target: "",
      peer_timestamp: "",
      peer_nonce: "",
      peer_body_sha256: "",
      peer_signature: "",
    };
    switch (request.operation) {
      case "execD1": {
        const decoded = yield* decode(Runtime.ExecD1Input, unsigned);
        return {
          ok: true,
          value: yield* management.operator.execD1(connection, decoded),
        } as const;
      }
      case "executeD1Statements": {
        const decoded = yield* decode(
          Runtime.ExecuteD1StatementsInput,
          unsigned,
        );
        return {
          ok: true,
          value: yield* management.operator.executeD1Statements(
            connection,
            decoded,
          ),
        } as const;
      }
      case "migrateD1": {
        const decoded = yield* decode(Runtime.MigrateD1Input, unsigned);
        return {
          ok: true,
          value: yield* management.operator.migrateD1(connection, decoded),
        } as const;
      }
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        ok: false as const,
        error:
          error instanceof FleetManagementError
            ? {
                reason: error.reason,
                message: error.message,
                ...(error.evidence ? { evidence: error.evidence } : {}),
              }
            : {
                reason: "transport" as const,
                message:
                  "Celld D1 operation failed; inspect durable state before retrying a mutation.",
              },
      }),
    ),
  );

/** Synchronous IAM invocation only. No Function URL and no automatic retries. */
export const FleetManagementLambda = Layer.effect(
  FleetManagement,
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const http = yield* HttpClient.HttpClient;
    const services = Layer.mergeAll(
      Layer.succeed(Credentials, credentials),
      Layer.succeed(HttpClient.HttpClient, http),
      Layer.succeed(Retry, { while: () => false }),
    );
    const call = <A>(
      connection: FleetConnection,
      operation: typeof Operations.Type,
      input: unknown,
      schema: Schema.Schema<A>,
    ) =>
      Effect.gen(function* () {
        const functionArn = connection.hostState?.managementFunctionArn;
        if (
          typeof functionArn !== "string" ||
          !/^arn:aws(?:-us-gov|-cn)?:lambda:[a-z0-9-]+:\d{12}:function:[a-zA-Z0-9-_]+(?::[a-zA-Z0-9$_-]+)?$/.test(
            functionArn,
          ) ||
          !connection.bucket
        )
          return yield* Effect.fail(
            new FleetManagementError({
              reason: "configuration",
              message:
                "Fleet hostState must include an IAM managementFunctionArn and backing bucket.",
            }),
          );
        const response = yield* LambdaSdk.invoke({
          FunctionName: functionArn,
          InvocationType: "RequestResponse",
          LogType: "None",
          Payload: yield* encode({
            version: 1,
            bucket: connection.bucket.uri,
            operation,
            input,
          }),
        }).pipe(
          Effect.provide(services),
          Effect.mapError(
            () =>
              new FleetManagementError({
                reason: "transport",
                message:
                  "IAM Celld management invocation failed; do not retry an ambiguous mutation.",
              }),
          ),
        );
        if (
          response.StatusCode !== 200 ||
          response.FunctionError ||
          !response.Payload
        )
          return yield* Effect.fail(
            new FleetManagementError({
              reason: "transport",
              message:
                "Celld management runner did not return a successful synchronous response; mutation outcome may be ambiguous.",
            }),
          );
        const chunks = yield* Stream.runCollect(response.Payload).pipe(
          Effect.mapError(
            () =>
              new FleetManagementError({
                reason: "transport",
                message:
                  "Celld management response was interrupted; mutation outcome may be ambiguous.",
              }),
          ),
        );
        const body = yield* Effect.sync(
          () =>
            new Uint8Array(
              Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
            ),
        );
        const envelope = yield* decode(Response, yield* parse(body));
        if (!envelope.ok)
          return yield* Effect.fail(new FleetManagementError(envelope.error));
        return yield* decode(schema, envelope.value);
      }).pipe(
        Effect.timeout("85 seconds"),
        Effect.mapError((error) =>
          error instanceof FleetManagementError
            ? error
            : new FleetManagementError({
                reason: "transport",
                message:
                  "Celld management invocation timed out; mutation outcome may be ambiguous.",
              }),
        ),
      );
    const d1 = <A>(effect: Effect.Effect<A, FleetManagementError>) =>
      effect.pipe(
        Effect.mapError(
          () =>
            new OperatorError({
              message:
                "IAM Celld D1 operation failed; inspect durable state before retrying a mutation.",
            }),
        ),
      );
    return {
      reload: (connection, graph) =>
        call(connection, "reload", graph, ReloadEvidence),
      activate: (connection, graph) =>
        call(connection, "activate", graph, ActivateEvidence),
      operator: {
        execD1: (connection, input) =>
          d1(call(connection, "execD1", input, Runtime.ExecD1Output)),
        executeD1Statements: (connection, input) =>
          d1(
            call(
              connection,
              "executeD1Statements",
              input,
              Runtime.ExecuteD1StatementsOutput,
            ),
          ),
        migrateD1: (connection, input) =>
          d1(call(connection, "migrateD1", input, Runtime.MigrateD1Output)),
      },
    } satisfies FleetManagementService;
  }),
);

export interface ManagementRunnerProps {
  /** Dedicated existing fleet backing bucket, without s3://. */
  readonly bucketName: string;
  /** IAM partition for bucket ARNs. @default aws */
  readonly partition?: string;
  /** Private subnets and a management-only security group. */
  readonly vpc: { subnetIds: string[]; securityGroupIds: string[] };
  /** Number of live node sessions required. @default 1 */
  readonly minimumNodes?: number;
}

/** Compose into EcsFleet and persist only its functionArn in hostState.managementFunctionArn. */
export const ManagementRunner = (
  id: string,
  props: InputProps<ManagementRunnerProps>,
) =>
  Effect.gen(function* () {
    const main = yield* Effect.sync(() => import.meta.url);
    const runner = yield* LambdaFunction(id, {
      main,
      functionUrl: false,
      runtime: "nodejs22.x",
      memorySize: 256,
      timeout: Duration.seconds(75),
      vpc: props.vpc,
      env: {
        CELLD_MANAGEMENT_BUCKET: props.bucketName,
        CELLD_MANAGEMENT_MINIMUM_NODES: String(props.minimumNodes ?? 1),
      },
    });
    const arn = Output.interpolate`arn:${props.partition ?? "aws"}:s3:::${props.bucketName}`;
    yield* runner.bind("CelldManagementStore", {
      policyStatements: [
        {
          Effect: "Allow",
          Action: ["s3:GetObject"],
          Resource: [
            Output.interpolate`${arn}/nodes/*`,
            Output.interpolate`${arn}/fleet/peer-auth.json`,
            Output.interpolate`${arn}/deploy/*`,
            Output.interpolate`${arn}/alchemy/application/v1/publisher.json`,
            Output.interpolate`${arn}/alchemy/application/v1/current.json`,
            Output.interpolate`${arn}/alchemy/deployments/v1/candidates/*`,
          ],
        },
        {
          Effect: "Allow",
          Action: ["s3:ListBucket"],
          Resource: [arn],
          Condition: { StringLike: { "s3:prefix": ["nodes/"] } },
        },
      ],
    });
    return runner;
  });

const run = (event: unknown) =>
  Effect.gen(function* () {
    const bucketName = yield* Config.String("CELLD_MANAGEMENT_BUCKET");
    const region = yield* Config.String("AWS_REGION");
    const minimumNodes = yield* Config.Number("CELLD_MANAGEMENT_MINIMUM_NODES");
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucketName))
      return yield* Effect.fail(
        new FleetManagementError({
          reason: "configuration",
          message: "Invalid management runner bucket configuration.",
        }),
      );
    const credentials = yield* yield* Credentials;
    const http = yield* HttpClient.HttpClient;
    const connection: FleetConnection = {
      bucket: { uri: `s3://${bucketName}`, region },
    };
    const store = yield* makeS3Store(
      connection.bucket!,
      {
        AWS_ACCESS_KEY_ID: Redacted.value(credentials.accessKeyId),
        AWS_SECRET_ACCESS_KEY: Redacted.value(credentials.secretAccessKey),
        ...(credentials.sessionToken
          ? { AWS_SESSION_TOKEN: Redacted.value(credentials.sessionToken) }
          : {}),
        AWS_REGION: region,
      },
      http,
    );
    const options: ManagementOptions = { minimumNodes };
    const management = makeLocalFleetManagement(
      (requested) =>
        requested.bucket?.uri === connection.bucket?.uri
          ? Effect.succeed(store)
          : Effect.fail(
              new FleetStorageError({
                reason: "configuration",
                message: "Runner fleet mismatch.",
              }),
            ),
      http,
      options,
    );
    return yield* handleManagementRequest(event, connection, management);
  }).pipe(
    Effect.catch(() =>
      Effect.succeed({
        ok: false as const,
        error: {
          reason: "configuration" as const,
          message:
            "Private Celld management runner is not configured or cannot access its backing store.",
        },
      }),
    ),
    Effect.provide(
      Layer.mergeAll(
        fromEnv(),
        FetchHttpClient.layer,
        Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" }),
      ),
    ),
  );

/** Standard Lambda boundary; invocation is authorized by IAM, never an HTTP URL. */
export default (event: unknown) => Effect.runPromise(run(event));
