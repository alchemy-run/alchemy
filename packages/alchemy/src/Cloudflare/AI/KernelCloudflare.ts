/**
 * The Cloudflare kernel — the same `AI.Kernel` contract as
 * `AI.KernelMemory`, with runs hosted on Durable Objects: ONE DO
 * instance per run (named `${term}/${key}`), the thread and inbox in
 * DO storage, `Thread.remind` on the DO alarm, actor verbs as RPC.
 *
 * Swapping substrates is one line:
 *
 * ```ts
 * const OrgAgents = Layer.mergeAll(IssueOwnerLive, EngineerLayer).pipe(
 *   Layer.provideMerge(Cloudflare.AI.KernelCloudflare),   // ← or AI.KernelMemory
 *   Layer.provideMerge(Model),
 * );
 *
 * export default class OrgWorker extends Cloudflare.Worker<OrgWorker>()(
 *   "OrgWorker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const owner = yield* IssueOwner;
 *     yield* GitHub.consumeRepositoryEvents(repo, { events }, route(owner));
 *     return { fetch };
 *   }),
 *   OrgAgents,                                            // ← the layers slot
 * ) {}
 * ```
 *
 * ## How a charter reaches the DO
 *
 * A charter is CODE and cannot cross the wire — and it doesn't need
 * to: the Worker and its DO classes share ONE memoized layer build per
 * isolate (`WorkerBridge.getSharedBuild`), and the class-level
 * `layers` slot IS that build. So the agent layers build on the DO
 * side too, their `interpret` calls record `term → {charter, captured
 * context}` in this kernel's registrations, and the `AgentRuns` DO —
 * declared here, discovered as a binding because the layer yields it
 * during init — closes over that same map. An activating DO parses its
 * own name and becomes that run.
 *
 * Because the actor verbs are uniform, a door fired INSIDE a run RPCs
 * to the delegate's own DO: cross-run delegation is cross-DO by
 * construction.
 *
 * v1 (direct implementation — see designs/ai/kernel-cloudflare.md):
 * `dispatch` holds its RPC open for the round (KernelMemory's exact
 * call/reply semantics); durable continuations, compaction, and wire
 * modes come with the layering phase.
 */
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as S from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as Prompt from "effect/unstable/ai/Prompt";
import * as Response from "effect/unstable/ai/Response";
import type * as AiTool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import type { Actor, RunRef } from "../../AI/Actor.ts";
import { isAgent, type Agent } from "../../AI/Agent.ts";
import { isDispatchTool, type DispatchTool } from "../../AI/Dispatch.ts";
import { Refused, type KernelError } from "../../AI/Errors.ts";
import { isEvent } from "../../AI/Event.ts";
import {
  Kernel,
  type Charter,
  type Interpretable,
  type Turn,
  type TurnFn,
} from "../../AI/Kernel.ts";
import {
  asUserMessage,
  compileDispatch,
  compileSkillTool,
  compileSpawn,
  compileTool,
  dedupeByName,
  NOTE_CODA,
  noteMessage,
  render,
  type CompiledToolRef,
  type Stance,
} from "../../AI/KernelShared.ts";
import { KernelObserver, type KernelObservation } from "../../AI/Observer.ts";
import { isParameter } from "../../AI/Parameter.ts";
import { dedentTemplate, isFragment, type Fragment } from "../../AI/Prose.ts";
import { isSkill, type Skill, type SkillService } from "../../AI/Skill.ts";
import {
  Thread,
  Tick,
  type ThreadService,
  type TickService,
} from "../../AI/Thread.ts";
import { isTool, isToolImpl } from "../../AI/Tool.ts";
import type { MainRpc } from "../../Platform.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import { DurableObject } from "../Workers/DurableObject.ts";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";
import { Worker } from "../Workers/Worker.ts";

/** What one `interpret` call recorded — all the run engine needs to
 *  BECOME a run of this term when a DO activates. */
interface RegisteredCharter {
  readonly charter: Charter;
  /** The charter's own Layer graph, captured at interpret — tools,
   *  doors, and delegates resolve from it as on KernelMemory. */
  readonly context: Context.Context<never>;
  /** The delegate actors this term may reach (resolved lazily). */
  readonly term: Interpretable;
}

/** The DO name addressing one run of one term: `${term}/${key}`. */
const runName = (termName: string, key: string) => `${termName}/${key}`;

/** Split a DO name back into its term and key halves. The key may
 *  itself contain slashes (session keys are `${parent}/${agent}/${s}`),
 *  so only the FIRST segment is the term. */
const parseRunName = (name: string) => {
  const at = name.indexOf("/");
  return at < 0
    ? { term: name, key: name }
    : { term: name.slice(0, at), key: name.slice(at + 1) };
};

// ── storage layout (one run per DO) ──────────────────────────────────
// inbox:{seq}      pending inputs, drained per burst
// msg:{seq}        thread messages, appended (the transcript)
// remind:{fireAt}  scheduled notes (the alarm re-arms from these)
// meta             { tick, observed, active[], settled? }
const INBOX = "inbox:";
const MSG = "msg:";
const REMIND = "remind:";
const META = "meta";

/** Zero-padded so lexical key order IS arrival order. */
const seqKey = (prefix: string, seq: number) =>
  `${prefix}${String(seq).padStart(12, "0")}`;

interface RunMeta {
  readonly tick: number;
  readonly observed: number;
  readonly active: ReadonlyArray<string>;
  readonly settled?: { readonly outcome: unknown };
  readonly seq: number;
}

const emptyMeta: RunMeta = { tick: 0, observed: 0, active: [], seq: 0 };

/** The thread crosses storage in its ENCODED form — rows are JSON. */
const encodeMessages = S.encodeSync(S.Array(Prompt.Message));

type DistributiveOmit<T, K extends PropertyKey> = T extends any
  ? Omit<T, K>
  : never;

/**
 * A run's RPC surface — the {@link Actor} verbs, as one DO speaks them.
 * Uniform across every agent, which is what makes delegation
 * cross-DO for free: a door fired inside a run calls these on the
 * delegate's own instance.
 */
interface RunRpc extends MainRpc<DurableObjectState> {
  readonly deliver: (
    input: unknown,
    options?: { readonly parent?: RunRef },
  ) => Effect.Effect<void, unknown, RuntimeContext>;
  readonly dispatch: (
    input: unknown,
    options?: { readonly parent?: RunRef },
  ) => Effect.Effect<unknown, unknown, RuntimeContext>;
  readonly steer: (
    input: unknown,
  ) => Effect.Effect<void, unknown, RuntimeContext>;
  readonly settle: (
    outcome: unknown,
  ) => Effect.Effect<void, unknown, RuntimeContext>;
  readonly alarm: () => Effect.Effect<void, unknown, RuntimeContext>;
}

/**
 * The `AI.Kernel` for Cloudflare — no argument, and no class for the
 * user to declare: the runs DO is declared in this module and
 * discovered as a binding because this layer YIELDS it while building.
 *
 * It requires `Worker` for exactly that reason: the binding attaches
 * to the host whose bundle carries the class, so this layer only
 * builds inside a Worker (or a DO of one). That is the whole
 * difference from `AI.KernelMemory`'s `Layer<Kernel, never,
 * LanguageModel>` — the substrate is in the type.
 */
export const KernelCloudflare: Layer.Layer<
  Kernel,
  never,
  LanguageModel.LanguageModel | Worker
> = Layer.effect(
  Kernel,
  Effect.gen(function* () {
    const model = yield* LanguageModel.LanguageModel;
    const registrations = new Map<string, RegisteredCharter>();

    /**
     * The runs namespace: ONE Durable Object for every agent — the term
     * prefix of the instance name says which charter an activation
     * becomes. Declared HERE, not by the user, and closed over
     * `registrations`, which the shared layer build populates before
     * any activation's constructor runs.
     */
    const runs = yield* DurableObject<RunRpc>()(
      "AgentRuns",
      Effect.gen(function* () {
        const state = yield* DurableObjectState;
        const storage = state.storage;
        /**
         * WHO THIS ACTIVATION IS, read lazily. The constructor's outer
         * effect also runs at PLAN time — against a mock state with no
         * id — to discover this binding, so nothing here may touch the
         * instance eagerly. Every read below happens inside a
         * request-time effect.
         */
        let identity:
          | { readonly term: string; readonly key: string }
          | undefined;
        const me = {
          get term() {
            return (identity ??= parseRunName(String(state.id.name))).term;
          },
          get key() {
            return (identity ??= parseRunName(String(state.id.name))).key;
          },
        };

        // ── durable state accessors ─────────────────────────────────
        const readMeta = Effect.map(
          storage.get<RunMeta>(META).pipe(Effect.orDie),
          (found) => found ?? emptyMeta,
        );
        const writeMeta = (meta: RunMeta) =>
          storage.put(META, meta).pipe(Effect.orDie);

        const listRows = <A>(prefix: string) =>
          storage.list<A>({ prefix }).pipe(
            Effect.orDie,
            Effect.map((map) => [...map.entries()]),
          );

        const readThread = Effect.map(
          listRows<Prompt.MessageEncoded>(MSG),
          (rows) => Prompt.make(rows.map(([, message]) => message)),
        );

        const appendThread = (messages: ReadonlyArray<Prompt.MessageEncoded>) =>
          Effect.gen(function* () {
            if (messages.length === 0) return;
            const meta = yield* readMeta;
            const entries: Record<string, unknown> = {};
            let seq = meta.seq;
            for (const message of messages) {
              entries[seqKey(MSG, seq++)] = message;
            }
            yield* storage.put(entries).pipe(Effect.orDie);
            yield* writeMeta({ ...meta, seq });
          });

        // ── observations ────────────────────────────────────────────
        const observer = Context.getOption(
          yield* Effect.context<never>(),
          KernelObserver,
        );
        const observe = (
          observation: DistributiveOmit<
            KernelObservation,
            "term" | "key" | "seq" | "at"
          >,
        ) =>
          Option.isNone(observer)
            ? Effect.void
            : Effect.gen(function* () {
                const meta = yield* readMeta;
                yield* writeMeta({ ...meta, observed: meta.observed + 1 });
                yield* observer.value
                  .emit({
                    ...observation,
                    term: me.term,
                    key: me.key,
                    seq: meta.observed,
                    at: Date.now(),
                  } as KernelObservation)
                  .pipe(Effect.ignore);
              });

        /**
         * The round's waiters: `dispatch` RPCs held open for this
         * burst. v1 keeps them in memory — an eviction mid-round fails
         * the caller, which re-drives from the world (durable
         * continuations are the layering phase).
         */
        const waiters: Array<Deferred.Deferred<unknown>> = [];
        const pendingNotes: Array<Fragment> = [];
        /** Session children, for the supervision cascade. */
        const children = new Map<string, { term: string; key: string }>();

        const resolveWaiters = (value: unknown) =>
          Effect.forEach(waiters.splice(0), (w) => Deferred.succeed(w, value), {
            discard: true,
          });

        // ── the run-scoped AI.Thread / AI.Tick services ─────────────
        // storage is a RUNTIME capability; the run-scoped services the
        // kernel hands userland are plain effects, so seal it here
        const sealed = <A>(
          effect: Effect.Effect<A, never, RuntimeContext>,
        ): Effect.Effect<A> => Effect.provide(effect, RuntimeContext.phantom);

        const threadService: ThreadService = {
          get key() {
            return me.key;
          },
          tokens: sealed(
            Effect.map(readThread, (prompt) =>
              Math.ceil(JSON.stringify(prompt.content).length / 4),
            ),
          ),
          entries: sealed(Effect.map(readThread, (prompt) => prompt.content)),
          // v1: compaction is not yet applied on this substrate (the
          // thread is row-addressed; the plan lands with the layering
          // phase). Recording the request keeps the contract honest.
          compact: () => Effect.void,
          reply: (value) => resolveWaiters(value),
          // the KERNEL's clock, durable by construction: a row plus
          // the DO alarm. Delivery is an ordinary inbox message — a
          // wake if parked, queued if busy, dropped if settled.
          remind: (delay, note) =>
            sealed(
              Effect.gen(function* () {
                const fireAt = Date.now() + Duration.toMillis(delay);
                yield* storage.put(seqKey(REMIND, fireAt), note);
                // one alarm serves every pending note: it fires for the
                // EARLIEST and re-arms for the next
                const current = yield* storage.getAlarm();
                if (current === null || fireAt < current) {
                  yield* storage.setAlarm(fireAt);
                }
              }),
            ),
        };

        const provideRun = <A, E>(
          effect: Effect.Effect<A, E, any>,
          registration: RegisteredCharter,
          tick: TickService,
        ): Effect.Effect<A, E> =>
          effect.pipe(
            Effect.provideService(Thread, threadService),
            Effect.provideService(Tick, tick),
            Effect.provide(RuntimeContext.phantom),
            Effect.provide(registration.context),
          ) as Effect.Effect<A, E>;

        // ── capability resolution (from the charter's own context) ───
        const resolveHandler = (
          registration: RegisteredCharter,
          compiled: CompiledToolRef,
        ) =>
          Effect.gen(function* () {
            if (compiled.impl !== undefined) return compiled.impl;
            const name = compiled.term["~alchemy/Name"];
            const service = Context.getOption(
              registration.context,
              compiled.term as any,
            );
            if (Option.isNone(service)) {
              return yield* Effect.die(
                `KernelCloudflare: no implementation provided for tool '${name}' of '${me.term}'`,
              );
            }
            return service.value as (
              params: any,
            ) => Effect.Effect<any, any, any>;
          });

        const resolveSkill = (
          registration: RegisteredCharter,
          skill: Skill<string, any>,
        ) =>
          Effect.gen(function* () {
            const name = skill["~alchemy/Name"];
            const service = Context.getOption(
              registration.context,
              skill as any,
            );
            if (Option.isNone(service)) {
              return yield* Effect.die(
                `KernelCloudflare: no implementation provided for skill '${name}'`,
              );
            }
            // the IMPLEMENTATION carries the teaching: prose, spliced
            // tools, and their physics all come from the resolved
            // service — the term is only the name
            const impl = service.value as SkillService;
            const skillTools = impl.refs.filter(isTool);
            const handlers: Record<
              string,
              (params: any) => Effect.Effect<any, any, any>
            > = {};
            for (const tool of skillTools) {
              const toolName = tool["~alchemy/Name"];
              const resolved = impl.tools[toolName];
              if (resolved === undefined) {
                return yield* Effect.die(
                  `KernelCloudflare: skill '${name}' implementation provides no tool '${toolName}'`,
                );
              }
              handlers[toolName] = resolved;
            }
            return {
              prose: render(impl.template, impl.refs),
              tools: skillTools.map(compileTool),
              handlers,
              // a teaching may reference DEEPER skills: activating this
              // one exposes them for activation — the skill GRAPH
              skills: impl.refs.filter(isSkill),
            };
          });

        const resolveDelegate = (
          registration: RegisteredCharter,
          agent: Agent<any, any>,
        ) =>
          Effect.gen(function* () {
            const name = agent["~alchemy/Name"];
            const service = Context.getOption(
              registration.context,
              agent as any,
            );
            if (Option.isNone(service)) {
              return yield* Effect.die(
                `KernelCloudflare: no implementation provided for agent '${name}'`,
              );
            }
            return service.value as Actor;
          });

        // ── stance rendering (fragment tree → blocks + mentions) ─────
        const renderStance = (
          registration: RegisteredCharter,
          root: Fragment,
          tick: TickService,
        ): Effect.Effect<Stance> =>
          Effect.gen(function* () {
            const blocks: Array<string> = [];
            const tools = new Map<string, CompiledToolRef>();
            const skills = new Map<string, Skill<string, any>>();
            const delegates = new Map<string, Agent<any, any>>();
            const doors = new Map<string, DispatchTool<string, any[]>>();
            let buffer = "";
            const flush = () => {
              const text = buffer.trim();
              if (text.length > 0) blocks.push(text);
              buffer = "";
            };
            const walk = (fragment: Fragment): Effect.Effect<void> =>
              Effect.gen(function* () {
                const parts = dedentTemplate(fragment.template);
                buffer += parts[0] ?? "";
                for (let index = 0; index < fragment.refs.length; index++) {
                  const ref = fragment.refs[index];
                  if (isDispatchTool(ref)) {
                    doors.set(ref["~alchemy/Name"], ref);
                    buffer += `\`${ref["~alchemy/Name"]}\``;
                  } else if (isToolImpl(ref)) {
                    const name = ref.tool["~alchemy/Name"];
                    tools.set(name, { term: ref.tool, impl: ref.impl });
                    buffer += `\`${name}\``;
                  } else if (isTool(ref)) {
                    const name = ref["~alchemy/Name"];
                    if (!tools.has(name)) tools.set(name, { term: ref });
                    buffer += `\`${name}\``;
                  } else if (isSkill(ref)) {
                    skills.set(ref["~alchemy/Name"], ref);
                    buffer += `\`${ref["~alchemy/Name"]}\``;
                  } else if (isAgent(ref)) {
                    delegates.set(ref["~alchemy/Name"], ref as Agent<any, any>);
                    buffer += ref["~alchemy/Name"];
                  } else if (isEvent(ref) || isParameter(ref)) {
                    buffer += `\`${ref["~alchemy/Name"]}\``;
                  } else if (isFragment(ref)) {
                    flush();
                    yield* walk(ref);
                    flush();
                  } else if (Effect.isEffect(ref)) {
                    const value = yield* provideRun(
                      ref as Effect.Effect<unknown>,
                      registration,
                      tick,
                    );
                    if (isFragment(value)) {
                      flush();
                      yield* walk(value);
                      flush();
                    } else if (isToolImpl(value)) {
                      const name = value.tool["~alchemy/Name"];
                      tools.set(name, { term: value.tool, impl: value.impl });
                      buffer += `\`${name}\``;
                    } else if (isDispatchTool(value)) {
                      doors.set(value["~alchemy/Name"], value);
                      buffer += `\`${value["~alchemy/Name"]}\``;
                    } else {
                      buffer += String(value);
                    }
                  } else {
                    buffer += String(ref);
                  }
                  buffer += parts[index + 1] ?? "";
                }
              });
            yield* walk(root);
            flush();
            return { blocks, tools, skills, delegates, doors };
          });

        const buildToolkit = (
          tools: ReadonlyArray<AiTool.Any>,
          handlers: Record<
            string,
            (params: any) => Effect.Effect<any, any, any>
          >,
        ): Effect.Effect<Toolkit.WithHandler<any> | undefined> =>
          tools.length === 0
            ? Effect.succeed(undefined)
            : (Effect.gen(function* () {
                const kit = Toolkit.make(...tools) as Toolkit.Toolkit<any>;
                const subset: Record<string, unknown> = {};
                // handlers run INSIDE the DO's event, so the runtime
                // capability is already satisfied — seal it here rather
                // than at every construction site
                for (const tool of tools) {
                  const handler = handlers[tool.name];
                  if (handler === undefined) continue;
                  subset[tool.name] = (params: any) =>
                    Effect.provide(handler(params), RuntimeContext.phantom);
                }
                const handlerContext = yield* kit.toHandlers(subset as any);
                return (yield* Effect.provide(
                  kit as Effect.Effect<Toolkit.WithHandler<any>, never, any>,
                  handlerContext,
                )) as Toolkit.WithHandler<any>;
              }) as Effect.Effect<Toolkit.WithHandler<any> | undefined>);

        /** One sampling — tool handlers execute INSIDE this call. */
        const step = (
          prompt: Prompt.Prompt,
          toolkit: Toolkit.WithHandler<any> | undefined,
        ) =>
          Effect.gen(function* () {
            const parts: Array<unknown> = [];
            const open = new Map<
              string,
              { type: "text" | "reasoning"; text: string; metadata: any }
            >();
            yield* Stream.runForEach(
              (
                model.streamText as (
                  options: unknown,
                ) => Stream.Stream<any, unknown>
              )({ prompt, toolkit }),
              (part: any) =>
                Effect.sync(() => {
                  switch (part.type) {
                    case "text-start":
                    case "reasoning-start":
                      open.set(part.id, {
                        type: part.type === "text-start" ? "text" : "reasoning",
                        text: "",
                        metadata: { ...part.metadata },
                      });
                      return;
                    case "text-delta":
                    case "reasoning-delta": {
                      const kind =
                        part.type === "text-delta" ? "text" : "reasoning";
                      const block =
                        open.get(part.id) ??
                        ({ type: kind, text: "", metadata: {} } as any);
                      open.set(part.id, block);
                      block.text += part.delta;
                      Object.assign(block.metadata, part.metadata);
                      return;
                    }
                    case "text-end":
                    case "reasoning-end": {
                      const block = open.get(part.id);
                      if (block === undefined) return;
                      open.delete(part.id);
                      Object.assign(block.metadata, part.metadata);
                      parts.push(
                        Response.makePart(block.type, {
                          text: block.text,
                          metadata: block.metadata,
                        } as never),
                      );
                      return;
                    }
                    case "tool-call":
                    // the RESULT is load-bearing: it is what
                    // `Prompt.fromResponseParts` turns into the tool
                    // message answering the call. Drop it and the
                    // thread records a call nothing ever answered —
                    // providers reject that, and a model that reads
                    // its own thread calls the tool again forever
                    case "tool-result":
                    case "finish":
                      parts.push(part);
                      return;
                    default:
                      return;
                  }
                }),
            );
            for (const block of open.values()) {
              parts.push(
                Response.makePart(block.type, {
                  text: block.text,
                  metadata: block.metadata,
                } as never),
              );
            }
            return new LanguageModel.GenerateTextResponse<any>(parts as never);
          }).pipe(
            Effect.retry({
              schedule: Schedule.exponential("1 second"),
              times: 3,
            }),
            Effect.orDie,
          );

        // ── the BURST: drain → tick → sample → append, until quiescent
        // Concurrent events (two HTTP requests, an alarm during a
        // dispatch) each kick a burst, so the loop is SERIALIZED: the
        // second waits, then finds its input already drained by the
        // first and returns at once. One serial loop per run is the
        // kernel's contract, on this substrate too.
        const gate = yield* Semaphore.make(1);

        const burstOnce = Effect.gen(function* () {
          const registration = registrations.get(me.term);
          if (registration === undefined) {
            return yield* Effect.die(
              `KernelCloudflare: no charter registered for '${me.term}' — is its Layer in the worker's layers slot?`,
            );
          }

          // per-ACTIVATION init: the charter's closure is isolate
          // state (run-durable state lives in the thread/storage)
          let meta = yield* readMeta;
          const tickService = (count: number): TickService => ({
            count,
            say: (note) => Effect.sync(() => void pendingNotes.push(note)),
          });

          const initResult = yield* provideRun(
            registration.charter as Effect.Effect<unknown, unknown>,
            registration,
            tickService(meta.tick),
          ).pipe(Effect.orDie);
          const turn: Turn | TurnFn = isFragment(initResult)
            ? Effect.succeed(initResult)
            : (initResult as Turn | TurnFn);

          /**
           * Whether the LAST sampling was quiescent. An empty inbox is
           * only a park if it is — a sampling that called tools must
           * come back around to read their results, with no new input
           * at all. Starts `true` so a burst kicked with nothing to do
           * (its input already drained by the burst it queued behind)
           * parks instead of sampling.
           */
          let quiescent = true;

          while (true) {
            meta = yield* readMeta;
            if (meta.settled !== undefined) break;

            const rows = yield* listRows<unknown>(INBOX);
            if (rows.length === 0 && quiescent) {
              // PARKED: the run's work is done until the world moves.
              // On this substrate parking is RETURNING — the next
              // event (deliver, steer, alarm) kicks a fresh burst.
              yield* observe({ type: "parked" });
              break;
            }
            const inputs = rows.map(([, input]) => input);
            if (rows.length > 0) {
              yield* storage.delete(rows.map(([k]) => k)).pipe(Effect.orDie);
            }

            const messages: Array<Prompt.MessageEncoded> = [];
            for (const input of inputs) {
              messages.push(asUserMessage(input));
              yield* observe({
                type: "input",
                text: typeof input === "string" ? input : JSON.stringify(input),
              });
            }
            yield* appendThread(messages);

            // TICK — the stance for this sampling
            pendingNotes.length = 0;
            const tick = tickService(meta.tick);
            const result = yield* provideRun(
              Effect.suspend(() =>
                typeof turn === "function"
                  ? turn({ count: meta.tick, inputs })
                  : turn,
              ).pipe(
                Effect.retry({
                  while: (error) => !(error instanceof Refused),
                  schedule: Schedule.exponential("1 second"),
                  times: 3,
                }),
              ) as Effect.Effect<unknown>,
              registration,
              tick,
            );
            if (!isFragment(result)) {
              return yield* Effect.die(
                `KernelCloudflare: the turn of '${me.term}' returned a non-Fragment — turns return the stance; answer callers with AI.reply`,
              );
            }
            const stance = yield* renderStance(registration, result, tick);

            // notes (`AI.say`) — a plain append, in emission order
            const notes: Array<Prompt.MessageEncoded> = [];
            for (const note of pendingNotes.splice(0)) {
              const text = render(note.template as TemplateStringsArray, [
                ...note.refs,
              ]);
              if (text.length === 0) continue;
              notes.push(noteMessage(text));
              yield* observe({
                type: "input",
                text: `<note>\n${text}\n</note>`,
              });
            }
            yield* appendThread(notes);

            // the toolkit: charter tools + active skills + doors + intrinsics
            const handlers: Record<
              string,
              (params: any) => Effect.Effect<any, any, any>
            > = {};
            const tools: Array<AiTool.Any> = [];
            for (const [name, compiled] of stance.tools) {
              tools.push(compileTool(compiled.term));
              const resolved = yield* resolveHandler(registration, compiled);
              handlers[name] = (params: any) =>
                provideRun(resolved(params), registration, tick);
            }
            for (const [name, door] of stance.doors) {
              tools.push(compileTool(door as never));
              handlers[name] = (params: any) =>
                Effect.gen(function* () {
                  const derived = yield* door.policy(params, { key: me.key });
                  const actor = yield* resolveDelegate(
                    registration,
                    door.agent,
                  );
                  const agentName = door.agent["~alchemy/Name"];
                  if (derived.key !== undefined) {
                    children.set(`${agentName}:${derived.key}`, {
                      term: agentName,
                      key: derived.key,
                    });
                  }
                  yield* observe({
                    type: "dispatched",
                    tick: meta.tick,
                    toolName: name,
                    agent: agentName,
                    child: derived.key,
                  });
                  return yield* actor
                    .dispatch(derived.task, {
                      key: derived.key,
                      parent: { term: me.term, key: me.key },
                    })
                    .pipe(Effect.provide(RuntimeContext.phantom));
                });
            }
            const delegates = new Map<string, Actor>();
            for (const [name, agent] of stance.delegates) {
              delegates.set(name, yield* resolveDelegate(registration, agent));
            }
            if (delegates.size > 0) {
              tools.push(compileDispatch([...delegates.keys()]));
              handlers.dispatch = (params: {
                agent: string;
                task: string;
                session?: string;
              }) =>
                Effect.gen(function* () {
                  const actor = delegates.get(params.agent)!;
                  const childKey =
                    params.session === undefined
                      ? undefined
                      : `${me.key}/${params.agent}/${params.session}`;
                  if (childKey !== undefined) {
                    children.set(`${params.agent}:${childKey}`, {
                      term: params.agent,
                      key: childKey,
                    });
                  }
                  yield* observe({
                    type: "dispatched",
                    tick: meta.tick,
                    toolName: "dispatch",
                    agent: params.agent,
                    child: childKey,
                  });
                  const answer = yield* actor
                    .dispatch(params.task, {
                      key: childKey,
                      parent: { term: me.term, key: me.key },
                    })
                    .pipe(Effect.provide(RuntimeContext.phantom));
                  // a child's round can run for minutes; the answer
                  // arriving is the fact worth a breadcrumb, since a
                  // deployed run can only be read through its logs
                  yield* Effect.logDebug(
                    `[dispatch] ${params.agent} answered ${JSON.stringify(answer)?.slice(0, 120)}`,
                  );
                  return answer;
                });
            }
            if (stance.skills.size > 0) {
              tools.push(compileSkillTool([...stance.skills.keys()]));
              handlers.skill = (params: {
                action: "activate" | "deactivate";
                skill: string;
              }) =>
                Effect.gen(function* () {
                  const current = yield* readMeta;
                  const active = new Set(current.active);
                  if (params.action === "deactivate") {
                    active.delete(params.skill);
                    yield* writeMeta({ ...current, active: [...active] });
                    return `deactivated ${params.skill}`;
                  }
                  const skillTerm = stance.skills.get(params.skill);
                  if (skillTerm === undefined) {
                    return `no skill named '${params.skill}' is available right now`;
                  }
                  const resolved = yield* resolveSkill(registration, skillTerm);
                  active.add(params.skill);
                  yield* writeMeta({ ...current, active: [...active] });
                  return resolved.prose;
                });
            }
            // ACTIVE skills contribute their tools to this tick
            for (const name of meta.active) {
              const skillTerm = stance.skills.get(name);
              if (skillTerm === undefined) continue; // not reachable now
              const resolved = yield* resolveSkill(registration, skillTerm);
              tools.push(...resolved.tools);
              for (const [toolName, fn] of Object.entries(resolved.handlers)) {
                handlers[toolName] ??= (params: any) =>
                  provideRun(fn(params), registration, tick);
              }
            }
            tools.push(
              compileSpawn([...stance.tools.keys()], [...stance.skills.keys()]),
            );
            handlers.spawn = () =>
              // v1: anonymous workers are not yet hosted on this
              // substrate (each would be its own DO run) — the model
              // sees an honest refusal rather than a silent no-op
              Effect.succeed(
                "spawn is not available on this kernel yet — do the work yourself or dispatch a named agent",
              );

            const system = stance.blocks.join("\n\n") + NOTE_CODA;
            const toolkit = yield* buildToolkit(dedupeByName(tools), handlers);

            const thread = yield* readThread;
            const startedAt = Date.now();
            const response = yield* step(
              Prompt.concat(
                Prompt.make([{ role: "system", content: system }]),
                thread,
              ),
              toolkit,
            );

            yield* appendThread(
              encodeMessages(
                Prompt.fromResponseParts(response.content).content,
              ),
            );
            yield* observe({
              type: "assistant",
              tick: meta.tick,
              ms: Date.now() - startedAt,
              text: response.text,
              reasoning: response.reasoningText,
              toolCalls: response.toolCalls.map((call) => ({
                id: call.id,
                name: call.name,
                input: call.params,
              })),
            });
            meta = yield* readMeta;
            yield* writeMeta({ ...meta, tick: meta.tick + 1 });

            quiescent = response.toolCalls.length === 0;
            if (quiescent) {
              // the round's remaining waiters answer with the text —
              // the loop comes around once more and parks there
              yield* resolveWaiters(response.text);
            }
          }
        }).pipe(
          Effect.tapCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logError(
                `KernelCloudflare run '${me.term}/${me.key}' crashed`,
                cause,
              );
              yield* observe({ type: "crashed", error: String(cause) });
              // never leave a caller hanging on a dead round
              yield* resolveWaiters(undefined);
            }),
          ),
        );

        const burst = gate.withPermits(1)(burstOnce);

        const enqueue = (input: unknown) =>
          Effect.gen(function* () {
            const meta = yield* readMeta;
            yield* storage
              .put(seqKey(INBOX, meta.seq), input)
              .pipe(Effect.orDie);
            yield* writeMeta({ ...meta, seq: meta.seq + 1 });
          });

        return Effect.succeed<RunRpc>({
          deliver: (input: unknown, options?: { parent?: RunRef }) =>
            Effect.gen(function* () {
              const meta = yield* readMeta;
              if (meta.settled !== undefined) return;
              if (meta.tick === 0 && meta.seq === 0) {
                yield* observe({ type: "admitted", parent: options?.parent });
              }
              yield* enqueue(input);
              yield* state.waitUntil(burst);
            }),
          dispatch: (input: unknown, options?: { parent?: RunRef }) =>
            Effect.gen(function* () {
              const meta = yield* readMeta;
              if (meta.settled !== undefined) return meta.settled.outcome;
              if (meta.tick === 0 && meta.seq === 0) {
                yield* observe({ type: "admitted", parent: options?.parent });
              }
              const waiter = yield* Deferred.make<unknown>();
              yield* enqueue(input);
              waiters.push(waiter);
              // waitUntil, NOT forkChild: `AI.reply` answers this RPC
              // mid-round and the model keeps working afterwards, so
              // the loop must outlive the call that started it
              yield* state.waitUntil(burst);
              return yield* Deferred.await(waiter);
            }),
          steer: (input: unknown) =>
            Effect.gen(function* () {
              const meta = yield* readMeta;
              if (meta.settled !== undefined) return;
              yield* enqueue(input);
              yield* state.waitUntil(burst);
            }),
          settle: (
            outcome: unknown,
          ): Effect.Effect<void, never, RuntimeContext> =>
            Effect.gen(function* () {
              const meta = yield* readMeta;
              if (meta.settled !== undefined) return;
              yield* writeMeta({ ...meta, settled: { outcome } });
              yield* observe({ type: "settled" });
              yield* resolveWaiters(outcome);
              // the SUPERVISION cascade, cross-DO: a supervisor's end
              // ends the session workers it opened
              for (const child of children.values()) {
                yield* Effect.ignore(
                  runs
                    .getByName(runName(child.term, child.key))
                    .settle({ supervisor: { term: me.term, key: me.key } }),
                );
              }
              children.clear();
            }),
          /** Due reminders become ordinary inputs, then the alarm re-arms. */
          alarm: () =>
            Effect.gen(function* () {
              const now = Date.now();
              const rows = yield* listRows<string>(REMIND);
              const due = rows.filter(
                ([k]) => Number(k.slice(REMIND.length)) <= now,
              );
              for (const [, note] of due) {
                yield* enqueue(`[reminder] ${note}`);
              }
              if (due.length > 0) {
                yield* storage.delete(due.map(([k]) => k)).pipe(Effect.orDie);
              }
              const next = rows
                .map(([k]) => Number(k.slice(REMIND.length)))
                .filter((at) => at > now)
                .sort((a, b) => a - b)[0];
              if (next !== undefined) {
                yield* storage.setAlarm(next).pipe(Effect.orDie);
              }
              yield* burst;
            }),
        });
      }),
    );
    let minted = 0;
    const mintPrefix = crypto.randomUUID().slice(0, 8);

    const interpret = (term: Interpretable, charter: Charter) =>
      Effect.gen(function* () {
        const termName = term["~alchemy/Name"];
        registrations.set(termName, {
          charter,
          context: yield* Effect.context<never>(),
          term,
        });

        const stub = (key: string) => runs.getByName(runName(termName, key));
        const mint = () => `run-${mintPrefix}-${minted++}`;

        return {
          send: (item: unknown, options?: Parameters<Actor["send"]>[1]) =>
            stub(options?.key ?? mint())
              .deliver(item, { parent: options?.parent })
              .pipe(Effect.orDie, Effect.asVoid),
          dispatch: (
            item: unknown,
            options?: Parameters<Actor["dispatch"]>[1],
          ) =>
            stub(options?.key ?? mint())
              .dispatch(item, { parent: options?.parent })
              .pipe(Effect.orDie),
          steer: ((first: unknown, second?: unknown) =>
            second === undefined
              ? Effect.die(
                  new Error(
                    "KernelCloudflare: steer requires a key — steer(key, input)",
                  ),
                )
              : stub(first as string)
                  .steer(second)
                  .pipe(Effect.orDie, Effect.asVoid)) as Actor["steer"],
          settle: (runKey: string, outcome: unknown) =>
            stub(runKey).settle(outcome).pipe(Effect.orDie, Effect.asVoid),
          interrupt: () =>
            Effect.die(
              new Error(
                "KernelCloudflare: interrupt() is process-local; settle runs by key instead",
              ),
            ),
        } as Actor;
      }) as Effect.Effect<Actor, KernelError, never>;

    return { interpret };
  }),
);
