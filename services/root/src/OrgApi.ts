import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { buildOrgGraph } from "./Org.ts";

/**
 * `GET /api/org` — the org graph (Org.ts): groups, agents (charter,
 * pinned model, tools with schema summaries and attributed
 * permissions), and skills, all projected from the same static
 * declarations the driver runs. The mirror UI's data source.
 *
 * The registry handle is captured at build; its ROWS are read per
 * request — the agents' Layer builds (which record the acquisitions)
 * and this route's build race inside one Worker init, and a snapshot
 * taken here would lose whichever side finished later.
 */
export const OrgApi = Effect.gen(function* () {
  const registry = yield* Effect.serviceOption(Binding.AcquisitionRegistry);
  return HttpRouter.add(
    "GET",
    "/api/org",
    Effect.suspend(() =>
      HttpServerResponse.json(
        buildOrgGraph(
          Option.isSome(registry) ? registry.value.list() : [],
        ),
      ),
    ),
  );
});
