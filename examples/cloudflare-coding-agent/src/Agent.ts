import type { Session } from "alchemy/AI";
import * as Anthropic from "alchemy/Anthropic";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { AgentRpcs } from "./rpcs.ts";
import { Sandbox, WORKSPACE } from "./Sandbox.ts";

/**
 * One Durable Object per issue, serving this app's `AgentRpcs`. Every call
 * names its session, so one issue can run several.
 *
 * The session's container holds no credentials: the model API key and your
 * GitHub login are added to its requests by this Durable Object's egress,
 * which also decides what it may reach. Its history and its work (the
 * checkout, checkpointed after every turn) live in this Durable Object, so
 * the session picks up where it left off on any container.
 */
export class Agent extends Cloudflare.RpcDurableObject<Agent>()(
  "Agent",
  { schema: AgentRpcs },
  Effect.gen(function* () {
    const model = yield* Anthropic.Egress(Sandbox, {
      apiKey: Config.Redacted("ANTHROPIC_API_KEY"),
    });
    const github = yield* GitHub.Egress(Sandbox, {
      // Your `gh` login (the stack's GitHub auth profile), never in the container.
      token: GitHub.ProfileToken,
      repositories: [
        {
          repository: "alchemy-run/alchemy",
          contents: "write",
          pullRequests: "write",
          issues: "write",
          // The agent pushes its own branches, never main.
          push: { branches: ["agent/**"] },
        },
        // Its generated SDKs: a submodule, read only.
        { repository: "alchemy-run/distilled", contents: "read" },
      ],
    });
    const harness = yield* Cloudflare.Containers.Harness(Sandbox, {
      workspace: WORKSPACE,
      // Built once per image, then every session starts from it.
      prepare: {
        commands: [
          `git clone --depth 50 https://github.com/alchemy-run/alchemy ${WORKSPACE}`,
          `cd ${WORKSPACE} && git submodule update --init --depth 1 submodules/distilled`,
          // Not `tsc -b`: type-checking all of Alchemy and its generated SDKs
          // takes ~17-20 GB, over the largest container's 12 GiB.
          `cd ${WORKSPACE} && pnpm install --frozen-lockfile`,
        ],
        egress: [github],
        enableInternet: true,
        instance: "standard-4",
      },
    });
    return Effect.sync(() => {
      const claude = harness.start({
        egress: [model, github],
        // Package registries and docs; GitHub and the model go through egress.
        enableInternet: true,
        instance: "standard-4",
      });
      const call = <A, E, R>(sessionId: string, f: (session: Session) => Effect.Effect<A, E, R>) =>
        claude.pipe(
          Effect.flatMap((h) => h.get(sessionId)),
          Effect.flatMap(f),
          Effect.scoped,
        );
      return AgentRpcs.toLayer({
        // Idempotent: a session's id is stable.
        start: ({ sessionId, model }) =>
          claude.pipe(
            Effect.flatMap((h) => h.start({ id: sessionId, ...(model ? { model } : {}) })),
            Effect.flatMap((session) => session.info()),
            Effect.scoped,
          ),
        prompt: ({ sessionId, prompt }) => call(sessionId, (s) => s.prompt(prompt)),
        steer: ({ sessionId, prompt }) => call(sessionId, (s) => s.steer(prompt)),
        interrupt: ({ sessionId }) => call(sessionId, (s) => s.interrupt()),
        setModel: ({ sessionId, model }) => call(sessionId, (s) => s.setModel(model)),
        respond: ({ sessionId, requestId, answer }) =>
          call(sessionId, (s) => s.respond(requestId, answer)),
        result: ({ sessionId, turnId }) => call(sessionId, (s) => s.result(turnId)),
        info: ({ sessionId }) => call(sessionId, (s) => s.info()),
        // History is served from this object, with or without a container.
        events: ({ sessionId, after }) => harness.events(sessionId, { after }),
      });
    });
  }),
) {}
