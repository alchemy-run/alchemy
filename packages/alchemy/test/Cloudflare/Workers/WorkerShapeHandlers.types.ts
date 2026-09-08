import type { RpcWireShape } from "@/Cloudflare/Workers/InferEnv.ts";
import type { RpcAsync } from "@/Cloudflare/Workers/RpcAsync.ts";
import type { ExportedHandlerMethod } from "@/Cloudflare/Workers/Worker.ts";
import type { Rpc } from "@/Rpc.ts";
import type * as Effect from "effect/Effect";

type Shape = {
  fetch: Effect.Effect<unknown>;
  scheduled: (controller: unknown) => Effect.Effect<void>;
  email: (message: unknown) => Effect.Effect<void>;
  queue: (batch: unknown) => Effect.Effect<void>;
  greet: (name: string) => Effect.Effect<string>;
};

type Async = RpcAsync<Shape>;
type Wire = RpcWireShape<Shape>;

type Assert<T extends true> = T;

type _GreetOnAsync = Assert<"greet" extends keyof Async ? true : false>;
type _ScheduledNotOnAsync = Assert<
  "scheduled" extends keyof Async ? false : true
>;
type _EmailNotOnAsync = Assert<"email" extends keyof Async ? false : true>;
type _QueueNotOnAsync = Assert<"queue" extends keyof Async ? false : true>;
type _FetchNotOnAsync = Assert<"fetch" extends keyof Async ? false : true>;

type _GreetOnWire = Assert<"greet" extends keyof Wire ? true : false>;
type _ScheduledNotOnWire = Assert<
  "scheduled" extends keyof Wire ? false : true
>;
type _EmailNotOnWire = Assert<"email" extends keyof Wire ? false : true>;
type _QueueNotOnWire = Assert<"queue" extends keyof Wire ? false : true>;

// The Rpc brand on the Worker keeps the full init shape (including handlers);
// exclusion happens at the RPC client (`RpcAsync`) and wire (`RpcWireShape`).
type _RpcBrandKeepsScheduled = Assert<
  "scheduled" extends keyof Rpc.Shape<Rpc<Shape>> ? true : false
>;
type _HandlerUnionIncludesScheduled = Assert<
  "scheduled" extends ExportedHandlerMethod ? true : false
>;
