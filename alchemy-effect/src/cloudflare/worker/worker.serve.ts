import type { ExecutionContext } from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Worker from "./worker.ts";

export type { ExecutionContext };
export type * from "../../exports.ts";

export const serve =
  <const ID extends string, Req>(
    id: ID,
    {
      fetch,
    }: {
      fetch: (
        request: Request,
        env: unknown,
        ctx: ExecutionContext,
      ) => Effect.Effect<Response, never, Req>;
    },
  ) =>
  <const Props extends Worker.WorkerProps<Req>>(props: Props) =>
    Worker.Worker(id, { handle: fetch })(props);
