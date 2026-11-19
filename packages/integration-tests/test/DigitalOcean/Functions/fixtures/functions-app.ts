import * as DigitalOcean from "@alchemy.run/digitalocean";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { TestRegistry } from "../../fixtures/app/shared.ts";

export const Fns = DigitalOcean.Functions.Namespace("Fns", { region: "nyc1" });

export const Add = Effect.gen(function* () {
  const fns = yield* Fns;
  return yield* DigitalOcean.Functions.Action("Add", {
    namespace: fns,
    runtime: "nodejs:18",
    code: `function main(args) { return { sum: args.a + args.b } }`,
  });
});

/** Calls the function through `InvokeFunction`, with the App's own access key. */
export default class FunctionsApp extends DigitalOcean.App<FunctionsApp>()(
  "FunctionsApp",
  { main: import.meta.url, registry: TestRegistry, region: "nyc" },
  Effect.gen(function* () {
    const fn = yield* Add;
    const add = yield* DigitalOcean.Functions.InvokeFunction(fn);
    return {
      fetch: Effect.gen(function* () {
        const result = yield* add<{ sum: number }>({ a: 40, b: 2 });
        return yield* HttpServerResponse.json(result);
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(DigitalOcean.Functions.InvokeFunctionHttp)),
) {}
