import * as Effect from "effect/Effect";
import { Worker } from "../worker.ts";

export class WorkerA extends Worker.Resource("worker-a") {}
export class WorkerB extends Worker.Resource("worker-b") {}

export const workerA = WorkerA.serve(
  Effect.fn(function* (request) {
    // self-referential
    yield* WorkerA.fetch(request);
    // circular reference
    return yield* WorkerB.fetch(request);
  }),
);

export const workerB = WorkerB.serve(
  Effect.fn(function* (request) {
    // circular reference
    return yield* WorkerA.fetch(request);
  }),
);
