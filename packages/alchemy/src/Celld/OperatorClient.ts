import * as Runtime from "@distilled.cloud/celld/runtime";
import { Endpoint } from "@distilled.cloud/celld/Endpoint";
import { buildRequest } from "@distilled.cloud/core/protocol-http";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { FleetConnection } from "./Host.ts";

export type PeerHeaderKeys =
  | "peer_version"
  | "peer_source"
  | "peer_target"
  | "peer_timestamp"
  | "peer_nonce"
  | "peer_body_sha256"
  | "peer_signature";

/** A management operation failed; mutations are never automatically replayed. */
export class OperatorError extends Data.TaggedError("Celld.OperatorError")<{
  readonly message: string;
}> {}

export interface FleetOperatorService {
  readonly execD1: (
    connection: FleetConnection,
    input: Omit<Runtime.ExecD1Input, PeerHeaderKeys>,
  ) => Effect.Effect<Runtime.ExecD1Output, OperatorError>;
  readonly executeD1Statements: (
    connection: FleetConnection,
    input: Omit<Runtime.ExecuteD1StatementsInput, PeerHeaderKeys>,
  ) => Effect.Effect<Runtime.ExecuteD1StatementsOutput, OperatorError>;
  readonly migrateD1: (
    connection: FleetConnection,
    input: Omit<Runtime.MigrateD1Input, PeerHeaderKeys>,
  ) => Effect.Effect<Runtime.MigrateD1Output, OperatorError>;
}

/** Deployment-only operator transport, implemented by the fleet's host. */
export class FleetOperator extends Context.Service<
  FleetOperator,
  FleetOperatorService
>()("Celld.FleetOperator") {}

/** Address one live node session, not a load balancer or a cell identity. */
export interface LocalOperatorOptions {
  readonly endpoint: string;
  readonly target: string;
  readonly source: string;
  readonly peerKey: Redacted.Redacted<Uint8Array>;
  readonly httpClient: HttpClient.HttpClient;
}

/** Derive the same namespace-scoped ID as celld v0.5.0's d1_cell_scope. */
export const d1Scope = (identity: string) =>
  Effect.sync(() => {
    const key = createHash("sha256")
      .update("cells:v1:d1:__D1Database")
      .digest();
    const first = createHmac("sha256", key)
      .update(identity)
      .digest()
      .subarray(0, 16);
    const last = createHmac("sha256", key)
      .update(first)
      .digest()
      .subarray(0, 16);
    return `__D1Database:${Buffer.concat([first, last]).toString("hex")}`;
  });

/** Sign the generated serializer's exact bytes, including its encoded query. */
export const signOperatorInput = <
  I extends Pick<Runtime.ExecD1Input, PeerHeaderKeys>,
>(
  options: LocalOperatorOptions,
  schema: Schema.Schema<I>,
  input: Omit<I, PeerHeaderKeys>,
) =>
  Effect.gen(function* () {
    const timestamp = String(yield* Clock.currentTimeMillis);
    return yield* Effect.try({
      try: () => {
        const validIdentity = (value: string) =>
          /^[a-zA-Z0-9_.-]{1,128}$/.test(value) &&
          value !== "." &&
          value !== "..";
        if (
          !validIdentity(options.source) ||
          !validIdentity(options.target) ||
          Redacted.value(options.peerKey).length !== 32
        ) {
          throw new Error("Invalid peer session configuration");
        }
        const endpoint = new URL(options.endpoint);
        if (
          !["http:", "https:"].includes(endpoint.protocol) ||
          endpoint.username ||
          endpoint.password ||
          endpoint.search ||
          endpoint.hash
        ) {
          throw new Error("Invalid operator endpoint");
        }
        const peer = {
          peer_version: "5",
          peer_source: options.source,
          peer_target: options.target,
          peer_timestamp: timestamp,
          peer_nonce: Buffer.from(randomBytes(16)).toString("hex"),
          peer_body_sha256: "",
          peer_signature: "",
        };
        const request = buildRequest({
          input: { ...input, ...peer },
          inputAst: schema.ast,
          baseUrl: options.endpoint,
          headers: {},
        });
        if (request.body._tag !== "Uint8Array") {
          throw new Error(
            "Celld operator requests require a serialized JSON body",
          );
        }
        const url = new URL(request.url);
        peer.peer_body_sha256 = createHash("sha256")
          .update(request.body.body)
          .digest("hex");
        const canonical = [
          "cells-peer-request-v1",
          "5",
          request.method,
          `${url.pathname}${url.search}`,
          peer.peer_body_sha256,
          peer.peer_source,
          peer.peer_target,
          timestamp,
          peer.peer_nonce,
        ].join("\n");
        peer.peer_signature = createHmac(
          "sha256",
          Redacted.value(options.peerKey),
        )
          .update(canonical)
          .digest("hex");
        return { ...input, ...peer } as I;
      },
      catch: () =>
        new OperatorError({
          message: "Invalid Celld operator signing configuration or request.",
        }),
    });
  });

/** Local/private-network SDK adapter. The generated SDK has no retry policy. */
export const makeLocalFleetOperator = (
  options: LocalOperatorOptions,
): FleetOperatorService => {
  const services = Layer.mergeAll(
    Layer.succeed(Endpoint, options.endpoint),
    Layer.succeed(HttpClient.HttpClient, options.httpClient),
  );
  const call = <I extends Pick<Runtime.ExecD1Input, PeerHeaderKeys>, O, E>(
    schema: Schema.Schema<I>,
    operation: (input: I) => Effect.Effect<O, E, Runtime.CelldOpContext>,
    input: Omit<I, PeerHeaderKeys>,
  ): Effect.Effect<O, OperatorError> =>
    signOperatorInput(options, schema, input).pipe(
      Effect.flatMap(operation),
      Effect.mapError(
        () =>
          new OperatorError({
            message:
              "Celld operator request failed; inspect durable state before retrying a mutation.",
          }),
      ),
      Effect.provide(services),
    );
  return {
    execD1: (_connection, input) =>
      call(Runtime.ExecD1Input, Runtime.execD1, input),
    executeD1Statements: (_connection, input) =>
      call(
        Runtime.ExecuteD1StatementsInput,
        Runtime.executeD1Statements,
        input,
      ),
    migrateD1: (_connection, input) =>
      call(Runtime.MigrateD1Input, Runtime.migrateD1, input),
  };
};
