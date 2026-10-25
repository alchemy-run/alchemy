import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";

// Resources the fixture binds. Module-scope so the test stack yields the
// same declarations.

export const Identity = Azure.ManagedIdentity.UserAssignedIdentity("DiscoBindingsIdentity", {
  location: "eastus",
});

export const Bookshelf = Effect.gen(function* () {
  const identity = yield* Identity;
  return yield* Azure.Discovery.Bookshelf("DiscoBindingsBookshelf", {
    location: "eastus",
    workloadIdentities: [identity.identityId],
  });
});

export const Workspace = Effect.gen(function* () {
  const identity = yield* Identity;
  return yield* Azure.Discovery.Workspace("DiscoBindingsWorkspace", {
    location: "eastus",
    workspaceIdentity: identity.identityId,
  });
});

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/**
 * Effect-native Azure Function exercising the Microsoft Discovery read
 * bindings a new bookshelf and workspace can answer, one route per binding.
 */
export default class DiscoBindingsFunction extends Azure.Functions.Function<DiscoBindingsFunction>()(
  "DiscoBindingsFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const bookshelf = yield* Bookshelf;
    const workspace = yield* Workspace;
    const listKnowledgeBases = yield* Azure.Discovery.ListKnowledgeBases(bookshelf);
    const listConversations = yield* Azure.Discovery.ListConversations(workspace);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        switch (url.pathname) {
          case "/knowledge-bases":
            return yield* respond(Effect.map(listKnowledgeBases(), (page) => page.value.length));
          case "/conversations":
            return yield* respond(Effect.map(listConversations(), (page) => page.value.length));
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Azure.Discovery.ListKnowledgeBasesHttp, Azure.Discovery.ListConversationsHttp),
    ),
  ),
) {}
