import type { Convention, DeclaredNamespace, DeclaredTool, Evaluator } from "@alchemy.run/ai";
import { renderEvaluation, wrapScripts } from "@alchemy.run/ai/CodeMode";
import type { CodemodeSandboxBase } from "@earendil-works/pi-codemode";
import type {
  Extension as PiExtension,
  PromptSection,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { PiError } from "./Errors.ts";
import { fromPi } from "./internal/promise.ts";

/** The name of the tool code mode adds. */
export const CODEMODE_TOOL = "codemode";

/** The extension code mode's tool and prompt section are installed in. */
export const CODEMODE_EXTENSION = "codemode";

/** A tool a program may call, and the namespace it is declared in, if any. */
export interface Programmed {
  readonly tool: DeclaredTool;
  /** An MCP server's name: its tools are declared under it. */
  readonly namespace?: string;
}

/** The declarations of `tools`: loose tools first, then each namespace. */
export const namespaceOf = (
  programmed: ReadonlyArray<Programmed>,
): Omit<DeclaredNamespace, "name"> => {
  const namespaces = new Map<string, DeclaredTool[]>();
  for (const { tool, namespace } of programmed) {
    if (namespace === undefined) continue;
    namespaces.set(namespace, [...(namespaces.get(namespace) ?? []), tool]);
  }
  return {
    tools: programmed.flatMap(({ tool, namespace }) => (namespace === undefined ? [tool] : [])),
    namespaces: [...namespaces].map(([name, tools]) => ({ name, tools })),
  };
};

/** What a program is told about resuming, where Pi's journal runs it. */
const RESUMES =
  "- The program survives a restart: it resumes where it was, without running finished calls again.";

/** The section that declares the tools a conversation's programs may call. */
const sectionOf = (
  convention: Convention,
  programmed: ReadonlyMap<string, Programmed>,
): PromptSection => ({
  key: "codemode",
  render: ({ agent }) => {
    const callable = agent.callable.flatMap((tool) => {
      const entry = programmed.get(tool.name);
      return entry === undefined ? [] : [entry];
    });
    if (callable.length === 0) return undefined;
    const { declarations } = convention.program(namespaceOf(callable));
    return `${convention.heading}\n\n\`\`\`ts\n${declarations}\n\`\`\``;
  },
});

/**
 * Code mode as a Pi extension, written by `convention` and run by
 * `evaluator`: its `codemode` tool says how to write a program, its prompt
 * section declares the tools a program may call, and each program runs
 * wrapped so `tools` holds what the section declares.
 *
 * An evaluator that is Pi's VM runs programs through Pi's journal, so they
 * resume after a restart. Any other evaluator runs a program once, with
 * each tool call a nested call of Pi's.
 */
export const makeExtension = (
  evaluator: Evaluator,
  convention: Convention,
  /** Every tool a program may call, by its name where scripts run. */
  programmed: ReadonlyMap<string, Programmed>,
  context: Context.Context<RuntimeContext>,
): Effect.Effect<PiExtension, PiError, RuntimeContext> =>
  evaluator.vm === undefined
    ? Effect.succeed(evaluated(evaluator, convention, programmed, context))
    : Effect.flatMap(
        Effect.mapError(
          evaluator.vm,
          (cause) => new PiError({ message: `Code mode: ${cause.message}`, cause }),
        ),
        (sandbox) => journaled(sandbox, convention, programmed),
      );

/** A `codemode` tool of our own: the program runs once, where `evaluator` runs it. */
const evaluated = (
  evaluator: Evaluator,
  convention: Convention,
  programmed: ReadonlyMap<string, Programmed>,
  context: Context.Context<RuntimeContext>,
): PiExtension => {
  // A program is wrapped for every tool it could call; one a conversation
  // has disabled is unavailable to nested calls, and calling it fails.
  const every = convention.program(namespaceOf([...programmed.values()]));
  const tool: ToolRegistration = {
    name: CODEMODE_TOOL,
    description: convention.intro,
    parameters: {
      type: "object",
      properties: { code: { type: "string", description: "The program's source." } },
      required: ["code"],
    },
    // Programs cannot start programs.
    callers: ["model"],
    execute: async (args, api, toolContext) => {
      const code = (args as { code?: unknown }).code;
      const tools = Object.fromEntries(
        [...programmed].map(([name, { tool: declared }]) => [
          name,
          async (input: unknown) => {
            const result = await api.executeTool(
              name,
              (input ?? {}) as Parameters<typeof api.executeTool>[1],
              toolContext,
            );
            const structured = declared.success !== undefined;
            const value = result.structuredOutput;
            if (!result.isError || (structured && value !== undefined)) return value;
            const errors = result.diagnostics
              .filter((diagnostic) => diagnostic.severity === "error")
              .map((diagnostic) => diagnostic.message)
              .join("\n");
            throw new Error(
              (typeof value === "string" ? value : "") || errors || `Tool ${name} failed`,
            );
          },
        ]),
      );
      const { text, isError } = renderEvaluation(
        await Effect.runPromiseWith(context)(
          evaluator
            .run(every.wrap(typeof code === "string" ? code : ""), tools)
            .pipe(
              Effect.catch((cause) =>
                Effect.succeed({ ok: false as const, message: cause.message, output: [] }),
              ),
            ),
        ),
      );
      return { output: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
    },
  } as ToolRegistration;
  return {
    name: CODEMODE_EXTENSION,
    tools: [tool],
    sections: [sectionOf(convention, programmed)],
  };
};

/** Pi's own code mode extension over its VM, which replays a program from the journal. */
const journaled = (
  sandbox: CodemodeSandboxBase,
  convention: Convention,
  programmed: ReadonlyMap<string, Programmed>,
): Effect.Effect<PiExtension, PiError> =>
  Effect.gen(function* () {
    const { createCodemodeExtension } = yield* fromPi(
      () => import("@earendil-works/pi-durable/codemode"),
    );
    // A script is wrapped for every tool it could call; one a conversation
    // has disabled is missing where the script runs, and calling it fails.
    const every = convention.program(namespaceOf([...programmed.values()]));
    const extension = createCodemodeExtension({
      sandbox: wrapScripts(sandbox, every.wrap),
    }) as PiExtension;

    return {
      ...extension,
      name: CODEMODE_EXTENSION,
      tools: (extension.tools ?? []).map((tool: ToolRegistration) =>
        tool.name === CODEMODE_TOOL
          ? {
              ...tool,
              // Keep Pi's globals; replace how programs are written.
              description: [
                `${convention.intro}\n${RESUMES}`,
                ...tool.description.split("\n\n").slice(1),
              ].join("\n\n"),
            }
          : tool,
      ),
      sections: [sectionOf(convention, programmed)],
    };
  });
