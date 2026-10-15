import type { RuntimeContext } from "alchemy";
import * as Effect from "effect/Effect";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";

const result = Schema.Struct({
  value: Schema.Number,
  actorId: Schema.String,
  versionId: Schema.String,
});
const makeGroup = (size: number) =>
  RpcGroup.make(
    Rpc.make("call", { payload: { value: Schema.Number }, success: result }),
    ...Array.from({ length: size - 1 }, (_, index) =>
      Rpc.make(`unused_${index}`, {
        payload: { value: Schema.Number },
        success: result,
      }),
    ),
  );

export const Group1 = makeGroup(1);
export const Group20 = makeGroup(20);
export const Group100 = makeGroup(100);

export const handlersFor = (
  group: typeof Group1,
  actorId: string,
  version: Effect.Effect<{ readonly id: string }, never, RuntimeContext>,
) => {
  const call = ({ value }: { value: number }) =>
    Effect.map(version, ({ id }) => ({ value, actorId, versionId: id }));
  return group.toLayer({
    ...Object.fromEntries([...group.requests.keys()].map((name) => [name, call])),
    call,
  });
};
