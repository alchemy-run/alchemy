import * as Effect from "effect/Effect";
import { bind } from "../bind.ts";
import { Worker } from "../worker.ts";

class WorkerA extends Worker("worker-a") {}
class WorkerB extends Worker("worker-b") {}

const workerA = WorkerA.implement(
  Effect.fn(function* (request) {
    // self-referential
    yield* WorkerA.fetch(request);
    // circular reference
    return yield* WorkerB.fetch(request);
  }),
);

const workerB = WorkerB.implement(
  Effect.fn(function* (request) {
    // circular reference
    return yield* WorkerA.fetch(request);
  }),
);

await Effect.runPromise(workerA.pipe(bind(Worker.Fetch(WorkerB))));
