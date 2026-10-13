import { type Session, SessionError } from "alchemy/AI";
import * as Anthropic from "alchemy/Anthropic";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { INSTANCE, makeMachine } from "./machine.ts";
import { AgentRpcs } from "./rpcs.ts";
import { Sandbox, WORKSPACE } from "./Sandbox.ts";
import { Sessions, SESSIONS_INDEX } from "./Sessions.ts";
import { makeTerminals } from "./terminals.ts";

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
    const harness = yield* Cloudflare.Containers.Harness(Sandbox, { workspace: WORKSPACE });
    const sandbox = yield* Sandbox;

    /**
     * The workspace is ours: clone Alchemy into a container that has none
     * (a snapshot or checkpoint already restores it otherwise). Dependencies
     * are left to the agent.
     */
    const ensureWorkspace = Effect.scoped(
      Effect.gen(function* () {
        const child = yield* sandbox.exec([
          "sh",
          "-c",
          `[ -d ${WORKSPACE}/.git ] || git clone --depth 50 https://github.com/alchemy-run/alchemy ${WORKSPACE}`,
        ]);
        const { exitCode, stderr } = yield* child.output();
        if (exitCode !== 0) {
          return yield* new SessionError({
            message: `cloning the workspace failed: ${new TextDecoder().decode(stderr)}`,
          });
        }
      }),
    ).pipe(
      Effect.catchTag("ContainerError", (cause) =>
        Effect.fail(new SessionError({ message: cause.message })),
      ),
    );

    const terminals = makeTerminals(sandbox, { cwd: WORKSPACE });
    const sessions = yield* Sessions;
    const machine = makeMachine(sandbox);
    /** Work that must outlive the call that started it (a caller may disconnect). */
    const background = yield* Scope.make();

    return Effect.sync(() => {
      const claude = harness
        .start({
          egress: [model, github],
          // Package registries and docs; GitHub and the model go through egress.
          enableInternet: true,
          instance: INSTANCE,
        })
        .pipe(Effect.tap(() => ensureWorkspace));
      const call = <A, E, R>(sessionId: string, f: (session: Session) => Effect.Effect<A, E, R>) =>
        claude.pipe(
          Effect.flatMap((h) => h.get(sessionId)),
          Effect.flatMap(f),
          Effect.scoped,
        );
      /** A session as this object recorded it: reading it never starts the machine. */
      const recorded = (sessionId: string) =>
        harness.list().pipe(Effect.map((listed) => listed.find((info) => info.id === sessionId)));

      return AgentRpcs.toLayer({
        // Opening a session only reads its record; a new session starts its
        // machine (it's about to be used). Idempotent: a session's id is stable.
        start: ({ sessionId, model }) =>
          recorded(sessionId).pipe(
            Effect.flatMap((info) =>
              info
                ? Effect.succeed(info)
                : claude.pipe(
                    Effect.flatMap((h) => h.start({ id: sessionId, ...(model ? { model } : {}) })),
                    Effect.flatMap((session) => session.info()),
                    Effect.scoped,
                  ),
            ),
            // Listed for every browser.
            Effect.tap(() =>
              sessions.getByName(SESSIONS_INDEX).register(sessionId).pipe(Effect.ignore),
            ),
          ),
        prompt: ({ sessionId, prompt }) =>
          call(sessionId, (s) => s.prompt(prompt)).pipe(
            // New work brings a settled session back.
            Effect.tap(() =>
              sessions.getByName(SESSIONS_INDEX).unsettle(sessionId).pipe(Effect.ignore),
            ),
          ),
        steer: ({ sessionId, prompt }) => call(sessionId, (s) => s.steer(prompt)),
        interrupt: ({ sessionId }) => call(sessionId, (s) => s.interrupt()),
        setModel: ({ sessionId, model }) => call(sessionId, (s) => s.setModel(model)),
        respond: ({ sessionId, requestId, answer }) =>
          call(sessionId, (s) => s.respond(requestId, answer)),
        result: ({ sessionId, turnId }) => call(sessionId, (s) => s.result(turnId)),
        info: ({ sessionId }) =>
          recorded(sessionId).pipe(
            Effect.flatMap((info) =>
              info ? Effect.succeed(info) : call(sessionId, (s) => s.info()),
            ),
          ),
        // History is served from this object, with or without a container.
        events: ({ sessionId, after }) => harness.events(sessionId, { after }),
        // A shell in the session's container (started, with its workspace).
        terminal: ({ sessionId, cols, rows }) =>
          Stream.unwrap(
            Effect.scoped(claude).pipe(Effect.as(terminals.output(sessionId, cols, rows))),
          ),
        machine: ({ stats }) => machine({ stats }),
        summary: ({ sessionId }) =>
          Effect.all([machine(), harness.list()]).pipe(
            Effect.map(([m, listed]) => {
              const session = listed.find((info) => info.id === sessionId);
              return { machine: m.state, ...(session ? { session } : {}) };
            }),
          ),
        settle: ({ sessionId }) =>
          Effect.gen(function* () {
            // Settled at once; stopping the machine (checkpoint, snapshot)
            // takes a while, and must not be cancelled if the caller leaves.
            yield* sessions.getByName(SESSIONS_INDEX).settle(sessionId);
            yield* harness.stop().pipe(Effect.ignore, Effect.forkIn(background));
            return yield* machine();
          }),
        // Checkpoint and snapshot the work, then stop the container.
        suspend: () => harness.stop().pipe(Effect.andThen(machine())),
        resume: () => Effect.scoped(claude).pipe(Effect.andThen(machine({ stats: true }))),
        terminalInput: ({ sessionId, data }) => terminals.input(sessionId, data),
        terminalResize: ({ sessionId, cols, rows }) => terminals.resize(sessionId, cols, rows),
      });
    });
  }),
) {}
