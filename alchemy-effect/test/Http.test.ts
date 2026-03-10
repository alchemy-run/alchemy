import * as Http from "@/Http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Scope } from "effect/Scope";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { describe, expect, it } from "vitest";

describe("Http", () => {
  it("returns a 500 response for typed failures", async () => {
    const response = await invoke(
      Effect.fail({ message: "Boom" } as any),
    );

    expect(response.status).toBe(500);
    expect(response.statusText).toBe("Boom");
    expect(await response.text()).toBe("Boom");
  });

  it("returns a generic 500 response for defects", async () => {
    const response = await invoke(Effect.die("Boom"));

    expect(response.status).toBe(500);
    expect(response.statusText).toBe("Internal Server Error");
    expect(await response.text()).toBe("Internal Server Error");
  });
});

const invoke = async (
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, any, never>,
): Promise<Response> => {
  let response: Response | undefined;

  await Effect.runPromise(
    Http.serve(handler).pipe(
      Effect.provide(
        Layer.succeed(
          Http.HttpServer,
          Http.server({
            serve: (wrappedHandler) =>
              Effect.gen(function* () {
                const services = yield* Effect.services();
                response = HttpServerResponse.toWeb(yield* wrappedHandler, {
                  services,
                });
              }) as Effect.Effect<
                void,
                never,
                Exclude<
                  Effect.Services<typeof wrappedHandler>,
                  HttpServerRequest.HttpServerRequest | Scope
                >
              >,
          }),
        ),
      ),
    ),
  );

  if (!response) {
    throw new Error("No HTTP response was captured");
  }

  return response;
};
