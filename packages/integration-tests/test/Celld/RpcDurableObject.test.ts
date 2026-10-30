import { DurableObjectState } from "@alchemy.run/celld/DurableObjectState";
import { RpcDurableObject } from "@alchemy.run/celld/RpcDurableObject";
import { expect, it } from "@alchemy.run/test";
import { LiteralExpr } from "alchemy/Output";
import { Self } from "alchemy/Self";
import type { DurableObjectExport, DurableObjectEngineHost } from "alchemy/Workers/DurableObject";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Rpc, RpcGroup } from "effect/rpc";
import * as Schema from "effect/Schema";

class Calls extends RpcGroup.make(Rpc.make("hello", { success: Schema.String })) {}
class Room extends RpcDurableObject<Room>()("Room", { schema: Calls }) {}

it.effect(
  "Celld RPC declarations register native exports without constructing a server while planning",
  () =>
    Effect.gen(function* () {
      const exports = new Map<string, DurableObjectExport>();
      const bindings: unknown[] = [];
      const host: DurableObjectEngineHost & {
        durableObjectNamespaces: LiteralExpr<Record<string, string>>;
      } = {
        Type: "Celld.Worker",
        LogicalId: "RpcHost",
        durableObjectNamespaces: new LiteralExpr<Record<string, string>>({}),
        bind: () => (binding) =>
          Effect.sync(() => {
            bindings.push(binding);
          }),
        export: (name, value) =>
          Effect.sync(() => {
            exports.set(name, value);
          }),
        durableObjectBinding: (value) => value,
        durableObjectStub: (value) => value,
      };
      let initialized = 0;
      let constructed = 0;
      const implementation = Effect.gen(function* () {
        yield* DurableObjectState;
        initialized++;
        return Effect.sync(() => {
          constructed++;
          return Calls.toLayer({ hello: () => Effect.succeed("hello") });
        });
      });
      class Inline extends RpcDurableObject<Inline>()(
        "Inline",
        { schema: Calls },
        implementation,
      ) {}
      const context: Context.Context<any> = Context.make(Self, host).pipe(
        Context.add(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "plan" }),
        ),
      );
      const namespace = yield* Room.pipe(
        Effect.provide(
          Room.make(implementation).pipe(Layer.provideMerge(Layer.succeedContext(context))),
        ),
      );
      const inline = yield* Inline.pipe(Effect.provide(context));
      expect(namespace.kind).toBe("Celld.DurableObject");
      expect(namespace.name).toBe("Room");
      expect(typeof namespace.fetch).toBe("function");
      expect(inline.name).toBe("Inline");
      expect(initialized).toBe(2);
      expect(constructed).toBe(0);
      expect(exports.get("Room")?.kind).toBe("durableObject");
      expect(exports.get("Inline")?.kind).toBe("durableObject");
      expect(bindings).toHaveLength(2);
    }),
  { tags: ["unit", "local", "provider:celld"] },
);
