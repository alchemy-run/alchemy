import { Credentials } from "@distilled.cloud/aws/Credentials";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FleetStorageError } from "./FleetStorage.ts";
import { makeS3Store } from "./FleetStorageS3.ts";
import type { FleetConnection } from "./Host.ts";
import {
  ActivateEvidence,
  FleetManagementError,
  ManagementGraph,
  ReloadEvidence,
  makeLocalFleetManagement,
  type FleetManagementService,
  type ManagementOptions,
} from "./Management.ts";
import { OperatorError } from "./OperatorClient.ts";
import * as Runtime from "./Protocol/runtime.ts";

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
      if (bytes.length > 1024 * 1024) throw new Error("Management payload too large");
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
    try: () => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
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
      return yield* new FleetManagementError({
        reason: "configuration",
        message: "Management runner is bound to a different fleet bucket.",
      });
    if (request.operation === "reload" || request.operation === "activate") {
      const graph = yield* decode(ManagementGraph, request.input);
      const value =
        request.operation === "activate"
          ? yield* decode(ActivateEvidence, yield* management.activate(connection, graph))
          : yield* decode(ReloadEvidence, yield* management.reload(connection, graph));
      return { ok: true, value } as const;
    }
    const input = yield* decode(Schema.Record(Schema.String, Schema.Unknown), request.input);
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
        const decoded = yield* decode(Runtime.ExecuteD1StatementsInput, unsigned);
        return {
          ok: true,
          value: yield* management.operator.executeD1Statements(connection, decoded),
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

/**
 * How a management request reaches its runner: the encoded request
 * envelope in, the runner's encoded response envelope out. A transport owns
 * its own deadlines and reports every failure whose mutation outcome is
 * unknown as an ambiguous `transport` failure.
 */
export type ManagementTransport = (
  connection: FleetConnection,
  payload: Uint8Array,
) => Effect.Effect<Uint8Array, FleetManagementError>;

/**
 * The deploy-time {@link FleetManagementService} over a transport chosen
 * per fleet connection: encode the request envelope, send it, and decode the
 * runner's response for the operation.
 */
export const makeManagementClient = (
  transportFor: (
    connection: FleetConnection,
  ) => Effect.Effect<ManagementTransport, FleetManagementError>,
): FleetManagementService => {
  const call = <A>(
    connection: FleetConnection,
    operation: typeof Operations.Type,
    input: unknown,
    schema: Schema.Schema<A>,
  ) =>
    Effect.gen(function* () {
      if (!connection.bucket)
        return yield* new FleetManagementError({
          reason: "configuration",
          message: "Fleet connection must include its backing bucket.",
        });
      const transport = yield* transportFor(connection);
      const payload = yield* encode({
        version: 1,
        bucket: connection.bucket.uri,
        operation,
        input,
      });
      const body = yield* transport(connection, payload);
      const envelope = yield* decode(Response, yield* parse(body));
      if (!envelope.ok) return yield* new FleetManagementError(envelope.error);
      return yield* decode(schema, envelope.value);
    });
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
    reload: (connection, graph) => call(connection, "reload", graph, ReloadEvidence),
    activate: (connection, graph) => call(connection, "activate", graph, ActivateEvidence),
    operator: {
      execD1: (connection, input) => d1(call(connection, "execD1", input, Runtime.ExecD1Output)),
      executeD1Statements: (connection, input) =>
        d1(call(connection, "executeD1Statements", input, Runtime.ExecuteD1StatementsOutput)),
      migrateD1: (connection, input) =>
        d1(call(connection, "migrateD1", input, Runtime.MigrateD1Output)),
    },
  } satisfies FleetManagementService;
};

/** Read-only access to the fleet state a management runner observes. */
export const managementStorePolicy = (partition: string | undefined, bucketName: Input<string>) => {
  const arn = Output.interpolate`arn:${partition ?? "aws"}:s3:::${bucketName}`;
  return [
    {
      Effect: "Allow" as const,
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
      Effect: "Allow" as const,
      Action: ["s3:ListBucket"],
      Resource: [arn],
      Condition: { StringLike: { "s3:prefix": ["nodes/"] } },
    },
  ];
};

/**
 * Execute one request envelope as this fleet's trusted runner, wherever the
 * runner is hosted (the private Lambda, an ECS task): configuration comes
 * from the runner's environment, storage credentials from its ambient
 * {@link Credentials}, and every failure becomes a response envelope.
 */
export const executeManagementRequest = (event: unknown) =>
  Effect.gen(function* () {
    const bucketName = yield* Config.String("CELLD_MANAGEMENT_BUCKET");
    const region = yield* Config.String("AWS_REGION");
    const minimumNodes = yield* Config.Number("CELLD_MANAGEMENT_MINIMUM_NODES");
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucketName))
      return yield* new FleetManagementError({
        reason: "configuration",
        message: "Invalid management runner bucket configuration.",
      });
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
    Effect.orElseSucceed(() => ({
      ok: false as const,
      error: {
        reason: "configuration" as const,
        message:
          "Private Celld management runner is not configured or cannot access its backing store.",
      },
    })),
  );

/** The runner's HTTP client: node requests never follow redirects. */
export const ManagementRunnerHttp = Layer.mergeAll(
  FetchHttpClient.layer,
  Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" }),
);
