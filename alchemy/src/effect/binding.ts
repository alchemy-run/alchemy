import * as Effect from "effect/Effect";
import { Env } from "./env.ts";
import { allow, type Statement } from "./policy.ts";

export const binding = <Client>() =>
  new Proxy(
    {},
    {
      get:
        (_, name: any) =>
        <Stmt extends Statement>() =>
        <R extends { id: string }>(
          resource: R,
          // @ts-expect-error
          ...params: Parameters<Client[keyof Client]>
        ) =>
          Effect.gen(function* () {
            yield* allow<Stmt>();
            const env = yield* Env;
            return yield* Effect.promise(() =>
              ((env[resource.id] as Client)[name as keyof Client] as any)(
                ...params,
              ),
            );
          }) as Effect.Effect<void, never, Stmt | Env>,
    },
  ) as {
    [Name in keyof Client]: <Stmt extends Statement>() => <
      R extends { id: string },
    >(
      resource: R,
      // @ts-expect-error
      ...params: Parameters<Client[Name]>
    ) => Effect.Effect<
      // @ts-expect-error
      Awaited<ReturnType<Client[Name]>>,
      never,
      Stmt | Env
    >;
  };
