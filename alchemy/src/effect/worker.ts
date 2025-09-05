import type { Effect } from "effect/Effect";
import type { Instance } from "./ctor.ts";
import type { Allow, Policy } from "./policy.ts";

export type Worker<Decl> = {
  decl: Decl;
  fetch(request: Request): Effect<Response, never, never>;
};

// TODO
type HttpError = never;

export interface WorkerDecl<ID extends string = any> {
  type: "Worker";
  id: ID;
  new (
    _: never,
  ): {
    type: "Worker";
    id: ID;
  };
  fetch<Self>(
    this: Self,
    request: Request,
  ): Effect<Response, HttpError, Policy<Worker.Fetch<Instance<Self>>>>;
  implement<Self, Err = never, Req = never>(
    this: Self,
    fetch: (request: Request) => Effect<Response, Err, Req>,
  ): Effect<Worker<Instance<Self>>, never, Policy.Normalize<Req>>;
}

export declare function Worker<ID extends string>(id: ID): WorkerDecl<ID>;

export declare namespace Worker {
  export type Fetch<W> = Allow<W, "Worker::Fetch">;
  export function Fetch<W>(worker: W): Policy<Fetch<Instance<W>>>;
}
