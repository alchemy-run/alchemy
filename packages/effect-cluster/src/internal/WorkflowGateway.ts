/**
 * How callers outside the cluster reach the workflows a pool hosts: four
 * RPCs on the pool's gateway, served by the pool's own
 * `ClusterWorkflowEngine`, and a `WorkflowEngine` for callers that sends
 * them. Payloads, results and signals cross as JSON, encoded with the
 * workflow's own schemas.
 *
 * @internal
 */
import {
  decodeExit,
  decodeResult,
  encodeExit,
  encodeResult,
  payloadCodec,
} from "alchemy/WorkflowEncoding";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Rpc, RpcClient, type RpcClientError, RpcGroup, RpcSerialization } from "effect/rpc";
import * as Schema from "effect/Schema";
import { DurableDeferred, Workflow, WorkflowEngine } from "effect/workflow";
import { GATEWAY_PATH, type GatewayTarget, gatewayFetch } from "./Gateway.ts";

const Run = { workflow: Schema.String, executionId: Schema.String };

export class WorkflowRpcs extends RpcGroup.make(
  Rpc.make("Workflow.Start", { payload: { ...Run, payload: Schema.Unknown } }),
  Rpc.make("Workflow.Poll", {
    payload: Run,
    success: Schema.Struct({
      state: Schema.Literals(["none", "suspended", "complete"]),
      result: Schema.optional(Schema.String),
    }),
  }),
  Rpc.make("Workflow.Interrupt", { payload: Run }),
  Rpc.make("Workflow.Signal", { payload: { ...Run, name: Schema.String, exit: Schema.String } }),
) {}

class UnknownWorkflow extends Data.TaggedError("Cluster.UnknownWorkflow")<{
  readonly workflow: string;
}> {}

/** The pool's side: each RPC on the pool's own engine, for the workflows they host. */
export const workflowHandlers = (workflows: ReadonlyMap<string, Workflow.Any>) =>
  WorkflowRpcs.toLayer(
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine.WorkflowEngine;
      const find = (name: string) => {
        const workflow = workflows.get(name);
        return workflow === undefined
          ? Effect.die(new UnknownWorkflow({ workflow: name }))
          : Effect.succeed(workflow as Workflow.Workflow<string, any, any, any>);
      };
      return WorkflowRpcs.of({
        "Workflow.Start": ({ workflow: name, executionId, payload }) =>
          Effect.gen(function* () {
            const workflow = yield* find(name);
            const decoded = yield* Schema.decodeUnknownEffect(payloadCodec(workflow))(payload).pipe(
              Effect.orDie,
            );
            yield* engine.execute(workflow, {
              executionId,
              payload: decoded as object,
              discard: true,
            });
          }).pipe(Effect.orDie),
        "Workflow.Poll": ({ workflow: name, executionId }) =>
          Effect.gen(function* () {
            const workflow = yield* find(name);
            const result = yield* engine.poll(workflow, executionId);
            if (Option.isNone(result)) return { state: "none" as const };
            if (result.value._tag === "Suspended") return { state: "suspended" as const };
            return {
              state: "complete" as const,
              result: yield* encodeResult(workflow, result.value.exit),
            };
          }),
        "Workflow.Interrupt": ({ workflow: name, executionId }) =>
          Effect.flatMap(find(name), (workflow) => engine.interrupt(workflow, executionId)),
        // The exit arrives encoded with the deferred's own schemas, so it is
        // passed on through a deferred whose schemas leave it as it is.
        "Workflow.Signal": ({ workflow, executionId, name, exit }) =>
          Effect.flatMap(decodeExit(exit), (decoded) =>
            engine.deferredDone(
              DurableDeferred.make(name, { success: Schema.Unknown, error: Schema.Unknown }),
              { workflowName: workflow, executionId, deferredName: name, exit: decoded },
            ),
          ),
      });
    }),
  );

/** A step only runs inside a run, and runs only run on the pool. */
class RunsOnPool extends Data.TaggedError("Cluster.RunsOnPool")<{
  readonly operation: string;
}> {}

const onPool = (operation: string) => Effect.die(new RunsOnPool({ operation }));

/**
 * A caller's engine: starts and reads runs through the gateway of the
 * pool that hosts each workflow. `route` returns that gateway.
 */
export const makeRemoteEngine = (
  route: (workflowName: string) => Effect.Effect<GatewayTarget>,
): WorkflowEngine.WorkflowEngine["Service"] => {
  const call = <A>(
    workflowName: string,
    use: (
      client: RpcClient.FromGroup<typeof WorkflowRpcs, RpcClientError.RpcClientError>,
    ) => Effect.Effect<A, unknown>,
  ) =>
    Effect.gen(function* () {
      const target = yield* route(workflowName);
      const protocol = RpcClient.layerProtocolHttp({
        url: `${target.url.replace(/\/+$/, "")}${GATEWAY_PATH}`,
        transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(target.token)),
      }).pipe(Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson]));
      return yield* Effect.flatMap(RpcClient.make(WorkflowRpcs), use).pipe(
        Effect.scoped,
        Effect.provide(protocol),
        Effect.provideService(FetchHttpClient.Fetch, yield* gatewayFetch(target.service)),
      );
    }).pipe(Effect.orDie);

  const poll = (workflow: Workflow.Any, executionId: string) =>
    Effect.gen(function* () {
      const reply = yield* call(workflow._tag, (client) =>
        client["Workflow.Poll"]({ workflow: workflow._tag, executionId }),
      );
      if (reply.state === "none") return Option.none<Workflow.Result<unknown, unknown>>();
      if (reply.state === "suspended") return Option.some(Workflow.Suspended.make({}));
      return Option.some(
        yield* decodeResult(workflow as Workflow.AnyWithProps, reply.result ?? "null"),
      );
    });

  return WorkflowEngine.makeUnsafe({
    // Workflows run on their runners; nothing registers here.
    register: () => Effect.void,
    execute: (workflow, options) =>
      Effect.gen(function* () {
        const payload = yield* Schema.encodeEffect(payloadCodec(workflow as Workflow.AnyWithProps))(
          options.payload,
        ).pipe(Effect.orDie);
        yield* call(workflow._tag, (client) =>
          client["Workflow.Start"]({
            workflow: workflow._tag,
            executionId: options.executionId,
            payload,
          }),
        );
        if (options.discard) return undefined;
        return Option.getOrElse(yield* poll(workflow, options.executionId), () =>
          Workflow.Suspended.make({}),
        );
      }) as Effect.Effect<any>,
    poll,
    interrupt: (workflow, executionId) =>
      call(workflow._tag, (client) =>
        client["Workflow.Interrupt"]({ workflow: workflow._tag, executionId }),
      ),
    interruptUnsafe: (workflow, executionId) =>
      call(workflow._tag, (client) =>
        client["Workflow.Interrupt"]({ workflow: workflow._tag, executionId }),
      ),
    resume: () => Effect.void,
    activityExecute: () => onPool("Activity execution"),
    deferredResult: () => onPool("DurableDeferred reads"),
    deferredDone: ({ workflowName, executionId, deferredName, exit }) =>
      Effect.flatMap(encodeExit(exit), (text) =>
        call(workflowName, (client) =>
          client["Workflow.Signal"]({
            workflow: workflowName,
            executionId,
            name: deferredName,
            exit: text,
          }),
        ),
      ),
    scheduleClock: () => onPool("DurableClock scheduling"),
  });
};
