import * as Cloudflare from "@/Cloudflare";
import type { Output } from "@/Output.ts";
import * as Effect from "effect/Effect";

type Assert<T extends true> = T;
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

// The declared Worker exposes its Workflow binding on `env` with the
// physical name as an Output, and passes every other binding through.
const program = Effect.gen(function* () {
  const worker = yield* Cloudflare.Worker("Worker", {
    main: "./src/worker.ts",
    env: {
      MY_WORKFLOW: Cloudflare.Workflow<{ value: string }>("MyWorkflow", {
        className: "MyWorkflow",
      }),
      GREETING: "hello",
    },
  });
  return worker;
});

type DeclaredWorker = Effect.Success<typeof program>;
type MyWorkflow = DeclaredWorker["env"]["MY_WORKFLOW"];

type _WorkflowNameIsOutput = Assert<
  Equals<MyWorkflow["workflowName"], Output<string>>
>;
type _ScriptNameIsOutput = Assert<
  Equals<MyWorkflow["scriptName"], Output<string>>
>;
type _ClassNameIsString = Assert<Equals<MyWorkflow["className"], string>>;
type _ParamsArePreserved = Assert<
  Equals<Exclude<MyWorkflow["Params"], undefined>, { value: string }>
>;
// Declared with a `const` generic, so the literal survives as `"hello"`.
type _OtherBindingsPassThrough = Assert<
  DeclaredWorker["env"]["GREETING"] extends string ? true : false
>;

// The Output slots straight into a Queue subscription's source in the same
// stack.
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
