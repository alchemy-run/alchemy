import * as Azure from "@/Azure";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const RESOURCE_GROUP = "Azure-Functions-HostTest";
export const FUNCTION_APP = "alchemy-azfn-host-test";

export default class TestHost extends Azure.Functions.Function<TestHost>()(
  "TestHost",
  {
    main: import.meta.url,
    resourceGroup: RESOURCE_GROUP,
    functionAppName: FUNCTION_APP,
    env: { GREETING: "hello from azure" },
  },
  Effect.gen(function* () {
    yield* Azure.Functions.schedule("tick", "0 0 0 1 1 *", () =>
      Effect.log("tick"),
    );
    return {
      fetch: Effect.sync(() =>
        HttpServerResponse.text(process.env.GREETING ?? "missing"),
      ),
    };
  }),
) {}
