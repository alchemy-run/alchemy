import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as S from "effect/Schema";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as Prompt from "effect/unstable/ai/Prompt";
import * as AiTool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import { RuntimeContext } from "../RuntimeContext.ts";
import type { Actor } from "./Actor.ts";
import { isAgent } from "./Agent.ts";
import { isEvent } from "./Event.ts";
import { Kernel, type Interpretable } from "./Kernel.ts";
import { isParameter } from "./Parameter.ts";
import { isProcess } from "./Process.ts";
import { isSkill, type Skill, type SkillService } from "./Skill.ts";
import { isTool, type Tool } from "./Tool.ts";

/**
 * Render a term's tagged template into prose. Capability terms render
 * as their NAME (backticked, so the model sees the same identifier the
 * toolkit declares); anything else renders as its string value. This
 * is deliberately the smallest renderer that makes a charter readable
 * — richer rendering (resource identities, event descriptions inlined
 * at the mention) layers on later without changing the kernel.
 */
const renderRef = (ref: unknown): string => {
  if (isTool(ref) || isParameter(ref) || isEvent(ref) || isSkill(ref)) {
    return `\`${(ref as { "~alchemy/Name": string })["~alchemy/Name"]}\``;
  }
  if (isAgent(ref) || isProcess(ref)) {
    return (ref as { "~alchemy/Name": string })["~alchemy/Name"];
  }
  return String(ref);
};

const render = (template: TemplateStringsArray, refs: ReadonlyArray<any>) => {
  let out = template[0] ?? "";
  for (let index = 0; index < refs.length; index++) {
    out += renderRef(refs[index]) + (template[index + 1] ?? "");
  }
  return out.trim();
};

/**
 * Compile one `AI.Tool` term into an effect AI tool: the template is
 * the description, the spliced `Parameter`s are the schema.
 * `failureMode: "return"` is the org's failure discipline — a
 * handler's `Effect.fail(text)` is a MODEL-VISIBLE tool result the
 * agent reacts to, never a loop crash.
 */
const compileTool = (term: Tool<any, any[]>) => {
  const fields: Record<string, S.Top> = {};
  for (const ref of term.refs) {
    if (!isParameter(ref)) continue;
    // the Parameter's template IS the field's description — annotate
    // the schema so it reaches the provider's JSON schema (description
    // and schema are one artifact, all the way to the wire)
    const description = render(ref.template, ref.refs);
    fields[ref["~alchemy/Name"]] =
      description.length > 0
        ? ((ref.schema as any).annotate({ description }) as S.Top)
        : ref.schema;
  }
  return AiTool.make(term["~alchemy/Name"], {
    description: render(term.template, term.refs),
    parameters: S.Struct(fields) as any,
    success: S.Unknown,
    failure: S.Unknown,
    failureMode: "return",
  });
};

/**
 * Compile the ONE delegation tool for a charter's agent references:
 * `${Engineer}` and `${Reviewer}` in prose grant a single `dispatch`
 * affordance whose `agent` parameter is the CLOSED set of referenced
 * names — the model can only reach agents the charter hired. The task
 * must stand alone because the delegate's run is its OWN conversation
 * (fresh key, fresh transcript); the delegate never sees the host's.
 */
const compileDispatch = (names: ReadonlyArray<string>) =>
  AiTool.make("dispatch", {
    description:
      `Hand one task to another agent and await their answer. ` +
      `Available agents: ${names.join(", ")}. State the task ` +
      `completely — the agent sees only what you write here, never ` +
      `this conversation.`,
    parameters: S.Struct({
      agent: S.Literals(names as [string, ...string[]]),
      task: S.String,
    }) as any,
    success: S.Unknown,
    failure: S.Unknown,
    failureMode: "return",
  });

/**
 * Compile the intrinsic `spawn` tool: every interpreted term may
 * conjure ANONYMOUS, task-scoped workers to perform its duties — the
 * named term stays the representative and point of contact; spawns
 * are ephemeral labor. Spawning grants nothing new: a worker's tools
 * are a SUBSET of the spawner's (enum-constrained), its skills a
 * subset of the spawner's (handed over PRE-ACTIVATED), and workers
 * can neither spawn nor dispatch nor manage skills — no runaway
 * recursion, no laundered authority.
 */
const compileSpawn = (
  toolNames: ReadonlyArray<string>,
  skillNames: ReadonlyArray<string>,
) =>
  AiTool.make("spawn", {
    description:
      `Spawn a fresh subagent to perform one task and await its ` +
      `answer. Write its role in \`instructions\` and state the task ` +
      `completely — it sees only what you write here, never this ` +
      `conversation.` +
      (toolNames.length > 0
        ? ` Grant it a subset of your tools via \`tools\` ` +
          `(default: all of them).`
        : "") +
      (skillNames.length > 0
        ? ` Hand it skills via \`skills\` — they arrive activated, ` +
          `instructions and tools included (default: none).`
        : ""),
    parameters: S.Struct({
      instructions: S.String,
      task: S.String,
      ...(toolNames.length > 0
        ? {
            tools: S.optionalKey(
              S.Array(S.Literals(toolNames as [string, ...string[]])),
            ),
          }
        : {}),
      ...(skillNames.length > 0
        ? {
            skills: S.optionalKey(
              S.Array(S.Literals(skillNames as [string, ...string[]])),
            ),
          }
        : {}),
    }) as any,
    success: S.Unknown,
    failure: S.Unknown,
    failureMode: "return",
  });

/**
 * Compile the intrinsic `skill` tool: the charter's skill references
 * are ACCESS; this tool is ACTIVATION. Activating returns the skill's
 * prose (the documentation enters the conversation exactly when it is
 * needed) and enables its tools for the rest of the run; deactivating
 * retires them — the agent manages its own working set.
 */
const compileSkillTool = (names: ReadonlyArray<string>) =>
  AiTool.make("skill", {
    description:
      `Activate or deactivate one of your skills. Activating returns ` +
      `the skill's instructions and enables its tools for the rest of ` +
      `this conversation. Available skills: ${names.join(", ")}.`,
    parameters: S.Struct({
      action: S.Literals(["activate", "deactivate"]),
      skill: S.Literals(names as [string, ...string[]]),
    }) as any,
    success: S.Unknown,
    failure: S.Unknown,
    failureMode: "return",
  });

/** A work item or steering message, rendered as one user message. */
const asUserMessage = (input: unknown): Prompt.MessageEncoded => ({
  role: "user",
  content: [
    {
      type: "text",
      text: typeof input === "string" ? input : JSON.stringify(input),
    },
  ],
});

/** First occurrence wins — a shared tool appears once in a toolkit. */
const dedupeByName = (tools: ReadonlyArray<AiTool.Any>): Array<AiTool.Any> => {
  const seen = new Set<string>();
  return tools.filter((tool) =>
    seen.has(tool.name) ? false : (seen.add(tool.name), true),
  );
};

interface Run {
  readonly inbox: Queue.Queue<unknown>;
  /** Dispatch waiters — each resolves at the run's next quiescence. */
  readonly waiters: Array<Deferred.Deferred<unknown>>;
  /** The run's outer ending (`settle`); also ends the park. */
  readonly settled: Deferred.Deferred<unknown>;
}

/**
 * The in-memory Kernel: the smallest interpreter that makes a charter
 * LIVE. One Layer, one requirement (`LanguageModel`) — every other
 * capability (durability, tracing, compaction, sandboxes) is a Layer
 * to be added around it later, never a feature of the loop.
 *
 * What `interpret` builds, per term:
 *
 * - the charter renders once into the system prompt;
 * - spliced `AI.Tool` terms compile into the model's toolkit, their
 *   handlers resolved from the ambient context (the term's `Req`);
 * - the Actor is a keyed map of RUNS, each a mailbox + serial loop:
 *
 * ```
 * loop: drain mailbox → user messages
 *       generateText(prompt, toolkit)     (tools execute inside)
 *       append response parts
 *       tool calls?  → loop               (the agentic loop)
 *       quiescent    → resolve dispatch waiters with the text,
 *                      PARK: wait for steer/send (wake) or settle (end)
 * ```
 *
 * Steering is delivered at the SAMPLING BOUNDARY — queued while a
 * step is in flight, spliced as a user message before the next model
 * call, never aborting in-flight work (the pi/codex discipline).
 * `settle` ends a run idempotently from the outside; a settled run
 * ignores further input and answers late dispatches with its outcome.
 */
export const KernelMemory: Layer.Layer<
  Kernel,
  never,
  LanguageModel.LanguageModel
> = Layer.effect(
  Kernel,
  Effect.gen(function* () {
    const model = yield* LanguageModel.LanguageModel;

    const interpret = (term: Interpretable) =>
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const context = yield* Effect.context<never>();
        const system = render(term.template, term.refs);

        // compile the charter's tools; resolve each handler from the
        // ambient context (the term's Req made the tag available)
        const toolTerms = term.refs.filter(isTool);
        const handlers: Record<string, (params: any) => Effect.Effect<any>> =
          {};
        for (const tool of toolTerms) {
          const service = Context.getOption(context, tool as any);
          if (Option.isNone(service)) {
            return yield* Effect.die(
              `KernelMemory: no implementation provided for tool '${tool["~alchemy/Name"]}' of '${term["~alchemy/Name"]}'`,
            );
          }
          const resolved = Effect.isEffect(service.value)
            ? yield* service.value as Effect.Effect<any>
            : service.value;
          handlers[tool["~alchemy/Name"]] = (params) =>
            (resolved as (params: any) => Effect.Effect<any>)(params).pipe(
              Effect.provide(RuntimeContext.phantom),
            );
        }

        // compile the charter's AGENT references into ONE `dispatch`
        // tool: each referenced tag resolves to that delegate's Actor,
        // and the handler routes by name — hand the task over, await
        // the answer. (Process references stay inert: identity in
        // prose, no grant.)
        const delegateTerms = term.refs.filter(isAgent);
        const delegates = new Map<string, Actor>();
        for (const delegate of delegateTerms) {
          const name = delegate["~alchemy/Name"];
          const service = Context.getOption(context, delegate as any);
          if (Option.isNone(service)) {
            return yield* Effect.die(
              `KernelMemory: no implementation provided for agent '${name}' referenced by '${term["~alchemy/Name"]}'`,
            );
          }
          delegates.set(name, service.value as Actor);
        }
        if (delegates.size > 0) {
          handlers.dispatch = (params: { agent: string; task: string }) =>
            delegates
              .get(params.agent)!
              .dispatch(params.task)
              .pipe(Effect.provide(RuntimeContext.phantom));
        }

        // compile the charter's SKILL references: the skill's TAG
        // resolves to its implementation (the handlers record) — the
        // bundle is nominal and encapsulated; the kernel never reaches
        // through to individual tool tags. Access is granted by the
        // reference, activation is the run's act.
        const skillTerms = term.refs.filter(isSkill) as Array<
          Skill<string, any[], any>
        >;
        const skills = new Map<
          string,
          { readonly prose: string; readonly tools: Array<AiTool.Any> }
        >();
        for (const skill of skillTerms) {
          const skillName = skill["~alchemy/Name"];
          const service = Context.getOption(context, skill as any);
          if (Option.isNone(service)) {
            return yield* Effect.die(
              `KernelMemory: no implementation provided for skill '${skillName}' referenced by '${term["~alchemy/Name"]}'`,
            );
          }
          const impl = service.value as SkillService;
          const skillTools = skill.refs.filter(isTool);
          for (const tool of skillTools) {
            const name = tool["~alchemy/Name"];
            if (handlers[name] !== undefined) continue; // shared tool
            const resolved = impl.tools[name];
            if (resolved === undefined) {
              return yield* Effect.die(
                `KernelMemory: skill '${skillName}' implementation provides no tool '${name}'`,
              );
            }
            handlers[name] = (params) =>
              resolved(params).pipe(
                Effect.provide(RuntimeContext.phantom),
              ) as Effect.Effect<any>;
          }
          skills.set(skillName, {
            prose: render(skill.template, skill.refs),
            tools: skillTools.map(compileTool),
          });
        }

        const charterTools = toolTerms.map(compileTool);
        const charterToolNames = charterTools.map((tool) => tool.name);
        const skillNames = [...skills.keys()];

        /**
         * Assemble a toolkit from compiled tools + their handlers.
         * `extra` supplies PER-RUN handlers (the `skill` tool mutates
         * its own run's active set, so it cannot be shared).
         */
        const buildToolkit = (
          tools: ReadonlyArray<AiTool.Any>,
          extra?: Record<string, (params: any) => Effect.Effect<any>>,
        ): Effect.Effect<Toolkit.WithHandler<any> | undefined> =>
          tools.length === 0
            ? Effect.succeed(undefined)
            : (Effect.gen(function* () {
                const kit = Toolkit.make(...tools) as Toolkit.Toolkit<any>;
                // exactly the kit's handlers — toHandlers dies on keys
                // that name no tool in the kit
                const subset: Record<string, unknown> = {};
                for (const tool of tools) {
                  subset[tool.name] = extra?.[tool.name] ?? handlers[tool.name];
                }
                const handlerContext = yield* kit.toHandlers(subset as any);
                return (yield* Effect.provide(
                  kit as Effect.Effect<Toolkit.WithHandler<any>, never, any>,
                  handlerContext,
                )) as Toolkit.WithHandler<any>;
              }) as Effect.Effect<Toolkit.WithHandler<any> | undefined>);

        // one model step: everything the provider + toolkit do for one
        // sampling — tool handlers execute INSIDE this call
        const step = (
          prompt: Prompt.Prompt,
          toolkit: Toolkit.WithHandler<any> | undefined,
        ) =>
          (
            model.generateText as (
              options: unknown,
            ) => Effect.Effect<LanguageModel.GenerateTextResponse<any>, unknown>
          )({ prompt, toolkit }).pipe(Effect.orDie);

        const runs = new Map<string, Run>();
        let minted = 0;
        let lastKey: string | undefined;

        const loop = (
          run: Run,
          options: {
            readonly system: string;
            /** Rebuilt at every sampling — active skills change it. */
            readonly toolkit: Effect.Effect<
              Toolkit.WithHandler<any> | undefined
            >;
          },
        ) =>
          Effect.gen(function* () {
            let prompt = Prompt.make([
              { role: "system", content: options.system },
            ]);
            let quiescent = false;
            while (true) {
              if (yield* Deferred.isDone(run.settled)) break;
              let inputs: Array<unknown> = yield* Queue.clear(run.inbox);
              if (inputs.length === 0 && quiescent) {
                // PARKED: the run's work is done until the world moves
                const wake = yield* Effect.raceFirst(
                  Effect.map(Queue.take(run.inbox), (input) => ({
                    settled: false as const,
                    input,
                  })),
                  Effect.map(Deferred.await(run.settled), () => ({
                    settled: true as const,
                  })),
                );
                if (wake.settled) break;
                inputs = [wake.input, ...(yield* Queue.clear(run.inbox))];
              }
              for (const input of inputs) {
                prompt = Prompt.concat(prompt, [asUserMessage(input)]);
              }
              const response = yield* step(prompt, yield* options.toolkit);
              prompt = Prompt.concat(
                prompt,
                Prompt.fromResponseParts(response.content),
              );
              quiescent = response.toolCalls.length === 0;
              if (quiescent) {
                for (const waiter of run.waiters.splice(0)) {
                  yield* Deferred.succeed(waiter, response.text);
                }
              }
            }
            // settled: anyone still waiting gets the outer outcome
            const outcome = yield* Deferred.await(run.settled);
            for (const waiter of run.waiters.splice(0)) {
              yield* Deferred.succeed(waiter, outcome);
            }
          });

        /** Create a run and fork its loop into the interpret Scope. */
        const createRun = (options: {
          readonly system: string;
          readonly toolkit: Effect.Effect<Toolkit.WithHandler<any> | undefined>;
        }) =>
          Effect.gen(function* () {
            const created: Run = {
              inbox: yield* Queue.unbounded<unknown>(),
              waiters: [],
              settled: yield* Deferred.make<unknown>(),
            };
            yield* Effect.forkIn(
              loop(created, options).pipe(
                // a crashed loop must never strand its callers: the
                // failure exit propagates to every waiter (dispatch
                // dies with the same defect) and marks the run ended
                Effect.onExit((exit) =>
                  Exit.isFailure(exit)
                    ? Effect.gen(function* () {
                        for (const waiter of created.waiters.splice(0)) {
                          yield* Deferred.done(
                            waiter,
                            exit as Exit.Exit<never>,
                          );
                        }
                        yield* Deferred.done(
                          created.settled,
                          exit as Exit.Exit<never>,
                        );
                      })
                    : Effect.void,
                ),
              ),
              scope,
            );
            return created;
          });

        // the intrinsic spawn: an ANONYMOUS run with the spawner's
        // system prompt REPLACED by the written role, and a tool
        // subset — never spawn/dispatch (workers are leaves)
        handlers.spawn = (params: {
          instructions: string;
          task: string;
          tools?: ReadonlyArray<string>;
          skills?: ReadonlyArray<string>;
        }) =>
          Effect.gen(function* () {
            const granted =
              params.tools === undefined
                ? charterTools
                : charterTools.filter((tool) =>
                    params.tools!.includes(tool.name),
                  );
            // handed skills arrive PRE-ACTIVATED: prose joins the
            // worker's instructions, tools join its (fixed) toolkit
            const handed = (params.skills ?? []).flatMap((name) => {
              const skill = skills.get(name);
              return skill === undefined ? [] : [{ name, ...skill }];
            });
            const tools = dedupeByName([
              ...granted,
              ...handed.flatMap((skill) => skill.tools),
            ]);
            const system = [
              params.instructions,
              ...handed.map(
                (skill) => `## Skill: ${skill.name}\n\n${skill.prose}`,
              ),
            ].join("\n\n");
            const worker = yield* createRun({
              system,
              toolkit: buildToolkit(tools),
            });
            yield* Queue.offer(worker.inbox, params.task);
            const waiter = yield* Deferred.make<unknown>();
            worker.waiters.push(waiter);
            return yield* Deferred.await(waiter);
          });

        // the term's intrinsics: one dispatch (when agents are
        // referenced), one spawn, one skill switch (when skills are)
        const intrinsics: Array<AiTool.Any> = [
          ...(delegates.size > 0
            ? [compileDispatch([...delegates.keys()])]
            : []),
          compileSpawn(charterToolNames, skillNames),
          ...(skills.size > 0 ? [compileSkillTool(skillNames)] : []),
        ];

        /**
         * An ACTOR run's toolkit: charter tools + the tools of its
         * currently-active skills + intrinsics — rebuilt at every
         * sampling boundary, with the `skill` handler bound to THIS
         * run's active set.
         */
        const actorRunConfig = () => {
          const active = new Set<string>();
          const skillHandler = (params: {
            action: "activate" | "deactivate";
            skill: string;
          }) =>
            Effect.sync(() => {
              if (params.action === "deactivate") {
                active.delete(params.skill);
                return `deactivated ${params.skill}`;
              }
              active.add(params.skill);
              return skills.get(params.skill)!.prose;
            });
          return {
            system,
            toolkit: Effect.suspend(() =>
              buildToolkit(
                dedupeByName([
                  ...charterTools,
                  ...[...active].flatMap(
                    (name) => skills.get(name)?.tools ?? [],
                  ),
                  ...intrinsics,
                ]),
                { skill: skillHandler },
              ),
            ),
          };
        };

        /** Admit one item: create the run on first sight of its key. */
        const admit = (item: unknown, key?: string) =>
          Effect.gen(function* () {
            const runKey = key ?? `run-${minted++}`;
            let run = runs.get(runKey);
            if (run === undefined) {
              run = yield* createRun(actorRunConfig());
              runs.set(runKey, run);
            }
            lastKey = runKey;
            if (!(yield* Deferred.isDone(run.settled))) {
              yield* Queue.offer(run.inbox, item);
            }
            return run;
          });

        const actor: Actor = {
          send: (item, options) => Effect.asVoid(admit(item, options?.key)),
          dispatch: (item, options) =>
            Effect.gen(function* () {
              const run = yield* admit(item, options?.key);
              if (yield* Deferred.isDone(run.settled)) {
                return yield* Deferred.await(run.settled);
              }
              const waiter = yield* Deferred.make<unknown>();
              run.waiters.push(waiter);
              return yield* Deferred.await(waiter);
            }),
          steer: ((first: unknown, second?: unknown) =>
            Effect.gen(function* () {
              const [key, input] =
                second === undefined
                  ? [lastKey, first]
                  : [first as string, second];
              const run = key === undefined ? undefined : runs.get(key);
              if (run === undefined) return;
              if (yield* Deferred.isDone(run.settled)) return;
              yield* Queue.offer(run.inbox, input);
            })) as Actor["steer"],
          settle: (runKey, event) =>
            Effect.gen(function* () {
              const run = runs.get(runKey);
              if (run === undefined) return;
              // idempotent: a second settle changes nothing
              yield* Deferred.succeed(run.settled, event);
            }),
          interrupt: () =>
            Effect.gen(function* () {
              for (const run of runs.values()) {
                yield* Deferred.succeed(run.settled, {
                  interrupted: true,
                });
              }
            }),
        };
        return actor;
      });

    return { interpret } as Context.Service.Shape<typeof Kernel> as never;
  }) as never,
);
