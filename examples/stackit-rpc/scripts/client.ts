import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { TaskRpcs } from "../src/TaskRpcs.ts";

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(TaskRpcs);

  const task = yield* client.createTask({ title: "write docs" });
  const read = yield* client.getTask({ id: task.id });
  yield* Effect.log(read.title);
});

const Protocol = Layer.unwrap(
  Effect.gen(function* () {
    const url = yield* Config.String("TASK_RPC_URL");
    return RpcClient.layerProtocolHttp({ url });
  }),
).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(RpcSerialization.layerNdjson));

Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(Protocol)));
