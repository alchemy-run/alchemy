import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  return {
    ExecutionContext: {
      exports: {
        handler: () => Promise.resolve(new Response("not implemented")),
      },
    },
  } as any;
});
