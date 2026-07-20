import * as ECS from "@/AWS/ECS";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "nested-ecs-lambda.ts");

// A nested Platform (ECS.Task) yielded DIRECTLY inside the Lambda's init
// program — the shape that used to OOM the Lambda sandbox at init (the ECS
// Bindings handler avoids it with `Resource.ref`). This exercises the
// nested-Platform ConfigProvider interceptor path in Platform.ts: the outer
// Lambda's intercepting ConfigProvider is the ambient provider while the
// nested Task's layer builds, and the fix ensures the host `get` reads
// `process.env` directly instead of recursing back through the interceptor.
//
// The busybox `docker.dockerfile` override keeps the Task cheaply deployable
// (the bundled program is never executed); we only need the Task to deploy
// and the Lambda sandbox to boot.
class NestedOneShotTask extends ECS.Task<NestedOneShotTask>()(
  "NestedReproOneShotTask",
  {
    main,
    cpu: 256,
    memory: 512,
    taskName: "alchemy-nested-repro-oneshot",
    docker: {
      dockerfile: [
        "FROM busybox:stable",
        'CMD ["sh", "-c", "echo alchemy-nested-repro-oneshot"]',
        "",
      ].join("\n"),
    },
  },
  Effect.gen(function* () {}),
) {}

export class NestedEcsReproFunction extends Lambda.Function<Lambda.Function>()(
  "NestedEcsReproFunction",
) {}

export default NestedEcsReproFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
    memorySize: 512,
  },
  Effect.gen(function* () {
    // Yielding the ECS Task (a Platform) directly inside the Lambda init is
    // the exact nesting that OOMed the sandbox before the Platform.ts fix.
    const task = yield* NestedOneShotTask;
    const containerName = yield* task.containerName;

    return {
      fetch: Effect.gen(function* () {
        // If the sandbox init recursed/OOMed, this route would never serve.
        return yield* HttpServerResponse.json({
          ok: true,
          taskType: task.Type,
          containerName,
        });
      }),
    };
  }),
);
