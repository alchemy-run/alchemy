import { describe, expect, it } from "@alchemy.run/test";
import * as BunHttpPlatform from "@effect/platform-bun/BunHttpPlatform";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiError from "effect/http-api/HttpApiError";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Etag from "effect/http/Etag";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import {
  BearerTokenValidator,
  StateAuth,
  StateAuthLive,
  StateAuthRequestLive,
  StateRequestValidator,
  ListStacks,
} from "@/State/HttpStateApi.ts";

class Group extends HttpApiGroup.make("fixture").add(ListStacks).middleware(StateAuth) {}
class Api extends HttpApi.make("fixture").add(Group) {}
const app = (auth: Layer.Layer<StateAuth>, onHandle: () => void) =>
  HttpRouter.toWebHandler(
    HttpApiBuilder.layer(Api).pipe(
      Layer.provide(
        HttpApiBuilder.group(Api, "fixture", (handlers) =>
          handlers.handle("listStacks", () =>
            Effect.sync(() => {
              onHandle();
              return [];
            }),
          ),
        ),
      ),
      Layer.provide(auth),
      Layer.provide(BunHttpPlatform.layer),
      Layer.provide(Etag.layer),
      Layer.provide(BunServices.layer),
    ),
    { disableLogger: true },
  );
const request = (authorization: string) =>
  new Request("https://state.example/state/stacks", {
    headers: { authorization, dpop: "fixture-proof" },
  });

describe("request-aware state authorization", { tags: ["unit", "local"] }, () => {
  it("provides the actual request and authorizes before executing the handler", async () => {
    const seen: string[] = [];
    const validator = Layer.succeed(StateRequestValidator, {
      validate: (request) =>
        Effect.sync(() => {
          expect(request.method).toBe("GET");
          expect(request.url.endsWith("/state/stacks")).toBe(true);
          expect(request.headers.authorization).toBe("DPoP fixture");
          expect(request.headers.dpop).toBe("fixture-proof");
          seen.push("authorize");
        }),
    });
    const server = app(StateAuthRequestLive.pipe(Layer.provide(validator)), () => {
      seen.push("handler");
    });
    try {
      expect((await server.handler(request("DPoP fixture"))).status).toBe(200);
      expect(seen).toEqual(["authorize", "handler"]);
    } finally {
      await server.dispose();
    }
  });

  it("denial never invokes the handler or falls back to bearer validation", async () => {
    let handled = false;
    const validator = Layer.succeed(StateRequestValidator, {
      validate: () => Effect.fail(HttpApiError.Unauthorized.make({})),
    });
    const server = app(StateAuthRequestLive.pipe(Layer.provide(validator)), () => {
      handled = true;
    });
    try {
      expect((await server.handler(request("Bearer fixture"))).status).toBe(401);
      expect(handled).toBe(false);
    } finally {
      await server.dispose();
    }
  });

  it("does not retry a denied request validator through another security scheme", async () => {
    for (const scheme of ["Bearer", "DPoP"]) {
      let validations = 0;
      let handled = false;
      const validator = Layer.succeed(StateRequestValidator, {
        validate: () =>
          Effect.suspend(() =>
            ++validations === 1 ? Effect.fail(HttpApiError.Unauthorized.make({})) : Effect.void,
          ),
      });
      const server = app(StateAuthRequestLive.pipe(Layer.provide(validator)), () => {
        handled = true;
      });
      try {
        expect((await server.handler(request(`${scheme} fixture`))).status).toBe(401);
        expect(validations).toBe(1);
        expect(handled).toBe(false);
      } finally {
        await server.dispose();
      }
    }
  });

  it("default state authentication accepts bearer and rejects DPoP", async () => {
    const validator = Layer.succeed(BearerTokenValidator, {
      validate: (token) =>
        token === "fixture" ? Effect.void : Effect.fail(HttpApiError.Unauthorized.make({})),
    });
    const server = app(StateAuthLive.pipe(Layer.provide(validator)), () => {});
    try {
      expect((await server.handler(request("Bearer fixture"))).status).toBe(200);
      expect((await server.handler(request("DPoP fixture"))).status).toBe(401);
    } finally {
      await server.dispose();
    }
  });
});
