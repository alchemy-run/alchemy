import type * as Effect from "effect/Effect";
import type { Resource } from "./resource.ts";

export declare namespace Service {
  export type Contract<A = any, Err = any> = (
    ...inputs: any[]
  ) => Effect.Effect<A, Err, never>;
}

export type Service<
  ID extends Resource.ID = Resource.ID,
  Contract extends Service.Contract = Service.Contract,
  A extends Awaited<ReturnType<Contract>> = Awaited<ReturnType<Contract>>,
  Err = never,
  Req = never,
> = {
  kind: "Service";
  id: ID;
  impl: (...inputs: Parameters<Contract>) => Effect.Effect<A, Err, Req>;
};

export const Service =
  <Contract extends Service.Contract>() =>
  <
    const ID extends Resource.ID,
    A extends Effect.Effect.Success<ReturnType<Contract>>,
    Err extends Effect.Effect.Error<ReturnType<Contract>> = any,
    Req = never,
  >(
    id: ID,
    impl: (...inputs: Parameters<Contract>) => Effect.Effect<A, Err, Req>,
  ) => ({
    kind: "Service",
    id,
    impl,
  });
