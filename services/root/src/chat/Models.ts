import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Engineer } from "../engineering/Engineer.ts";
import { EngineeringManager } from "../engineering/Manager.ts";
import { Head } from "../Head.ts";
import { catalog, DEFAULT_MODEL } from "../platform/Model.ts";

/** `${term}:${key}` → the session it names (the key may contain `:`). */
const parseSessionId = (id: string): { term: string; key: string } => {
  const at = id.indexOf(":");
  return at < 0
    ? { term: id, key: id }
    : { term: id.slice(0, at), key: id.slice(at + 1) };
};

/**
 * The models: the catalog the selector offers, and a session's pick —
 * the Head's (the Root Thread) or an engineer's.
 */
export const Models = Effect.gen(function* () {
  const head = yield* Head;
  const engineer = yield* Engineer;
  const manager = yield* EngineeringManager;

  const listModels = HttpRouter.add(
    "GET",
    "/api/models",
    Effect.gen(function* () {
      return yield* HttpServerResponse.json({
        models: catalog,
        default: DEFAULT_MODEL,
      });
    }),
  );

  /** `{ model }` from the body: a catalog id, or `null` for the
   *  default; anything else is a 400 (`undefined` result). */
  const readModel = Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const body = (yield* request.json.pipe(
      Effect.catch(() => Effect.succeed({})),
    )) as { model?: unknown };
    if (body.model === null) return { model: undefined as string | undefined };
    return typeof body.model === "string" &&
      catalog.some((entry) => entry.id === body.model)
      ? { model: body.model }
      : undefined;
  });
  const badModel = HttpServerResponse.json(
    {
      error: `model must be one of ${catalog.map((m) => m.id).join(", ")} or null`,
    },
    { status: 400 },
  );

  /** Read a session's pick — the Head's or an engineer's, over the
   *  session stub; `null` = the default. */
  const sessionModel = Effect.fn(function* (term: string, key: string) {
    if (term === Head["~alchemy/Name"]) {
      const model = yield* head.at(key).model();
      return { model: model ?? null, default: DEFAULT_MODEL };
    }
    if (term === Engineer["~alchemy/Name"]) {
      const model = yield* engineer.at(key).model();
      return { model: model ?? null, default: DEFAULT_MODEL };
    }
    if (term === EngineeringManager["~alchemy/Name"]) {
      const model = yield* manager.at(key).model();
      return { model: model ?? null, default: DEFAULT_MODEL };
    }
    return undefined;
  });

  const chatModel = HttpRouter.add(
    "GET",
    "/api/chats/:id/model",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const { term, key } = parseSessionId(
        decodeURIComponent(String(params.id ?? "")),
      );
      const found = yield* sessionModel(term, key);
      return found === undefined
        ? yield* HttpServerResponse.json(
            { error: "no model to pick for this session" },
            { status: 404 },
          )
        : yield* HttpServerResponse.json(found);
    }),
  );

  /** Choose a session's model — `{ model: id | null }`. Nothing in
   *  flight is cut; the pick lands from the next sampling on. */
  const chatModelSet = HttpRouter.add(
    "PUT",
    "/api/chats/:id/model",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const { term, key } = parseSessionId(
        decodeURIComponent(String(params.id ?? "")),
      );
      const chosen = yield* readModel;
      if (chosen === undefined) return yield* badModel;
      if (term === Head["~alchemy/Name"]) {
        yield* head.at(key).setModel(chosen.model);
      } else if (term === Engineer["~alchemy/Name"]) {
        yield* engineer.at(key).setModel(chosen.model);
      } else if (term === EngineeringManager["~alchemy/Name"]) {
        yield* manager.at(key).setModel(chosen.model);
      } else {
        return yield* HttpServerResponse.json(
          { error: "no model to pick for this session" },
          { status: 404 },
        );
      }
      return yield* HttpServerResponse.json(
        (yield* sessionModel(term, key)) ?? {
          model: chosen.model ?? null,
          default: DEFAULT_MODEL,
        },
      );
    }),
  );

  return Layer.mergeAll(listModels, chatModel, chatModelSet);
});
