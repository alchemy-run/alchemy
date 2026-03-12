import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  return {
    ExecutionContext: {
      exports: {
        handler: () => Promise.resolve("not implemented"),
      },
    },
  } as any;
});
