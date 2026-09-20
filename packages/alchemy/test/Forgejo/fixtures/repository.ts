import { destroy } from "@/RemovalPolicy.ts";
import * as Forgejo from "@/Forgejo/index.ts";
import { StackContext } from "@/StackContext.ts";
import { Stage } from "@/Stage.ts";
import * as Effect from "effect/Effect";
import * as Output from "@/Output.ts";

const repository = (id: string) =>
  Forgejo.Repository(id, {
    name: Output.fromEffect(
      Effect.gen(function* () {
        const stack = yield* StackContext;
        const stage = yield* Stage;
        const bytes = yield* Effect.sync(() =>
          new TextEncoder().encode(`${stack.name}:${stage}:${id}`),
        );
        const hash = yield* Effect.promise(() =>
          crypto.subtle.digest("SHA-256", bytes),
        );
        return yield* Effect.sync(
          () =>
            `alchemy-runtime-${Array.from(new Uint8Array(hash), (b) =>
              b.toString(16).padStart(2, "0"),
            )
              .join("")
              .slice(0, 24)}`,
        );
      }),
    ),
    owner: "alchemy-admin",
    private: true,
    autoInit: true,
  }).pipe(destroy());

export const Repository = repository("RuntimeRepository");
export const OtherRepository = repository("OtherRuntimeRepository");
