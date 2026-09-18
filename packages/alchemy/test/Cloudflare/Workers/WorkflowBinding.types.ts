import type * as cf from "@cloudflare/workers-types";
import * as Cloudflare from "@/Cloudflare";
import * as Output from "@/Output.ts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { AsyncWorkflowWorker } from "./fixtures/workflow-async/stack.ts";

type Assert<T extends true> = T;
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const container = Cloudflare.Container("Sandbox", { image: "alpine:latest" });
const program = Effect.gen(function* () {
  return yield* Cloudflare.Worker("Worker", {
    main: "./src/worker.ts",
    assets: "./public",
    env: {
      MY_WORKFLOW: Cloudflare.Workflow<{ value: string }>("Greeting", {
        className: "MyWorkflow",
      }),
      EFFECT_WORKFLOW: Effect.succeed(
        Cloudflare.Workflow<{ count: number }>("Count"),
      ),
      GREETING: "hello",
      CONFIG: Config.succeed("configured"),
      SECRET: Config.succeed(Redacted.make("secret")),
      EFFECT: Effect.succeed(42),
      OUTPUT: Output.literal("output"),
      CONTAINER: container,
    },
  });
});

type DeclaredWorker = Effect.Success<typeof program>;
type DeclaredEnv = DeclaredWorker["env"];
type MyWorkflow = DeclaredEnv["MY_WORKFLOW"];
type _WorkflowNameIsOutput = Assert<
  Equals<MyWorkflow["workflowName"], Output.Output<string>>
>;
type _ScriptNameIsOutput = Assert<
  Equals<MyWorkflow["scriptName"], Output.Output<string>>
>;
type _ClassNameIsString = Assert<Equals<MyWorkflow["className"], string>>;
type _ParamsArePreserved = Assert<
  Equals<Exclude<MyWorkflow["Params"], undefined>, { value: string }>
>;
type _EffectWorkflowParams = Assert<
  Equals<
    Exclude<DeclaredEnv["EFFECT_WORKFLOW"]["Params"], undefined>,
    { count: number }
  >
>;
type _Literal = Assert<Equals<DeclaredEnv["GREETING"], "hello">>;
type _Config = Assert<Equals<DeclaredEnv["CONFIG"], string>>;
type _Secret = Assert<Equals<DeclaredEnv["SECRET"], Redacted.Redacted<string>>>;
type _Effect = Assert<Equals<DeclaredEnv["EFFECT"], number>>;
type _OutputStaysDeferred = Assert<
  DeclaredEnv["OUTPUT"] extends Output.Output<string> ? true : false
>;
type _Assets = Assert<Equals<DeclaredEnv["ASSETS"], Cloudflare.Assets>>;
type _ContainerStaysDeclaration = Assert<
  Equals<DeclaredEnv["CONTAINER"], typeof container>
>;

type Env = Cloudflare.InferEnv<typeof program>;
type _DeclaredEnvRuntimeWorkflow = Assert<
  Equals<
    Cloudflare.InferEnv<DeclaredEnv>["MY_WORKFLOW"],
    cf.Workflow<{ value: string }>
  >
>;
type _RuntimeWorkflow = Assert<
  Equals<Env["MY_WORKFLOW"], cf.Workflow<{ value: string }>>
>;
type _RuntimeEffectWorkflow = Assert<
  Equals<Env["EFFECT_WORKFLOW"], cf.Workflow<{ count: number }>>
>;
type _RuntimeConfig = Assert<Equals<Env["CONFIG"], string>>;
type _RuntimeSecret = Assert<Equals<Env["SECRET"], string>>;
type _RuntimeEffect = Assert<Equals<Env["EFFECT"], number>>;
type _RuntimeOutput = Assert<Env["OUTPUT"] extends string ? true : false>;
// InferEnv returns ambient native types, whose DOM signatures differ from cf's module types.
type _RuntimeAssets = Assert<Equals<Env["ASSETS"], Service>>;
type _RuntimeContainer = Assert<
  Equals<Env["CONTAINER"], DurableObjectNamespace<Rpc.DurableObjectBranded>>
>;

type ClassWorker = Effect.Success<typeof AsyncWorkflowWorker>;
type ClassEnv = Cloudflare.InferEnv<typeof AsyncWorkflowWorker>;
type InstanceEnv = Cloudflare.InferEnv<AsyncWorkflowWorker>;
type _ClassOutput = Assert<
  Equals<
    ClassWorker["env"]["MY_WORKFLOW"]["workflowName"],
    Output.Output<string>
  >
>;
type _ClassRuntimeWorkflow = Assert<
  Equals<ClassEnv["MY_WORKFLOW"], cf.Workflow<{ value: string }>>
>;
type _ClassInstanceWorkflow = Assert<
  Equals<InstanceEnv["MY_WORKFLOW"], ClassEnv["MY_WORKFLOW"]>
>;
type _ClassAssets = Assert<Equals<ClassEnv["ASSETS"], Service>>;

const effectPropsWorker = Cloudflare.Worker(
  "EffectPropsWorker",
  Effect.succeed({
    main: "./src/worker.ts",
    env: { WORKFLOW: Cloudflare.Workflow<{ value: string }>("Greeting") },
  }),
);
type _EffectPropsOutput = Assert<
  Equals<
    Effect.Success<typeof effectPropsWorker>["env"]["WORKFLOW"]["workflowName"],
    Output.Output<string>
  >
>;

type _ExternalWorkerIsAWorker = Assert<
  DeclaredWorker extends Cloudflare.Worker ? true : false
>;
type _BaseWorkerHasNoEnv = Assert<
  Equals<Extract<"env", keyof Cloudflare.Worker>, never>
>;

const referencedWorker = Cloudflare.Worker.ref("Worker");
type _ReferenceHasNoEnv = Assert<
  Equals<Extract<"env", keyof Effect.Success<typeof referencedWorker>>, never>
>;

const nativeImplementation = Effect.succeed({
  fetch: Effect.succeed(HttpServerResponse.text("hello")),
});
const inlineWorker = Cloudflare.Worker(
  "InlineWorker",
  {
    main: "./src/worker.ts",
    env: { STR: "hello" },
  },
  nativeImplementation,
);
class EffectWorker extends Cloudflare.Worker<EffectWorker>()(
  "EffectWorker",
  {
    main: "./src/worker.ts",
    env: { STR: "hello" },
  },
  nativeImplementation,
) {}
class UnboundWorker extends Cloudflare.Worker<
  UnboundWorker,
  {
    ping: Effect.Effect<string>;
  }
>()("UnboundWorker") {}
const madeWorker = Effect.gen(function* () {
  return yield* UnboundWorker;
}).pipe(
  Effect.provide(
    UnboundWorker.make(
      { main: "./src/worker.ts", env: { STR: "hello" } },
      Effect.succeed({ ping: Effect.succeed("pong") }),
    ),
  ),
);

type _MadeWorkerHasNoEnv = Assert<
  Equals<Extract<"env", keyof Effect.Success<typeof madeWorker>>, never>
>;
type _InlineWorkerHasNoEnv = Assert<
  Equals<Extract<"env", keyof Effect.Success<typeof inlineWorker>>, never>
>;
type _EffectClassHasNoEnv = Assert<
  Equals<Extract<"env", keyof Effect.Success<typeof EffectWorker>>, never>
>;
type _UnboundWorkerHasNoEnv = Assert<
  Equals<Extract<"env", keyof Effect.Success<typeof UnboundWorker>>, never>
>;
type _WorkerRuntimeRetainsEnv = Assert<
  "env" extends keyof Effect.Success<typeof Cloudflare.Worker> ? true : false
>;

export const subscription = Effect.gen(function* () {
  const worker = yield* program;
  return yield* Cloudflare.Queues.Subscription("WorkflowEvents", {
    source: {
      type: "workflows.workflow",
      workflowName: worker.env.MY_WORKFLOW.workflowName,
    },
    events: ["instance.completed"],
    queueId: "queue-id",
  });
});
