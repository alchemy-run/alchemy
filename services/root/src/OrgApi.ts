import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { buildOrgGraph } from "./Org.ts";
import { skillConfig } from "./platform/SkillGateD1.ts";

/**
 * The org's structure API — the mirror UI's data source.
 *
 * - `GET /api/org` — the org graph (Org.ts): groups, agents (charter,
 *   pinned model, tools with schema summaries, skills with their
 *   runtime switch), and skills — all projected from the same static
 *   declarations the driver runs.
 * - `PATCH /api/org/agents/:agent/skills/:skill` `{ enabled }` — flip
 *   one agent's skill switch (the gate the driver consults at
 *   activation; running sessions with the skill already active keep
 *   it until they deactivate).
 *
 * The registry handle is captured at build; its ROWS are read per
 * request — the agents' Layer builds (which register the org nodes)
 * and this route's build race inside one Worker init, and a snapshot
 * taken here would lose whichever side finished later.
 */
export const OrgApi = Effect.gen(function* () {
  const structure = yield* Effect.serviceOption(AI.OrgRegistry);
  const config = yield* skillConfig;

  const nodes = () =>
    Option.isSome(structure) ? structure.value.list() : [];

  const graph = HttpRouter.add(
    "GET",
    "/api/org",
    Effect.gen(function* () {
      const disabled = yield* config
        .disabled()
        .pipe(Effect.catchCause(() => Effect.succeed(new Set<string>())));
      return yield* HttpServerResponse.json(
        buildOrgGraph(nodes(), disabled),
      );
    }),
  );

  const toggle = HttpRouter.add(
    "PATCH",
    "/api/org/agents/:agent/skills/:skill",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const agent = decodeURIComponent(String(params.agent ?? ""));
      const skill = decodeURIComponent(String(params.skill ?? ""));
      const found = buildOrgGraph(nodes()).agents.find(
        (candidate) => candidate.name === agent,
      );
      if (
        found === undefined ||
        !found.skills.some((candidate) => candidate.name === skill)
      ) {
        return yield* HttpServerResponse.json(
          { error: `no skill '${skill}' granted to agent '${agent}'` },
          { status: 404 },
        );
      }
      const request = yield* HttpServerRequest;
      const body = (yield* request.json.pipe(
        Effect.catch(() => Effect.succeed({})),
      )) as { enabled?: unknown };
      if (typeof body.enabled !== "boolean") {
        return yield* HttpServerResponse.json(
          { error: "body must be { enabled: boolean }" },
          { status: 400 },
        );
      }
      yield* config.set(agent, skill, body.enabled);
      return yield* HttpServerResponse.json({
        agent,
        skill,
        enabled: body.enabled,
      });
    }),
  );

  return Layer.mergeAll(graph, toggle);
});
