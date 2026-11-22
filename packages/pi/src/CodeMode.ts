import type { Convention, DeclaredNamespace, DeclaredTool } from "@alchemy.run/ai";
import { wrapScripts } from "@alchemy.run/ai/CodeMode";
import type { CodemodeSandboxBase } from "@earendil-works/pi-codemode";
import type {
  Extension as PiExtension,
  PromptSection,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import type { PiError } from "./Errors.ts";
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

/**
 * Pi's code mode extension, written by `convention` and run in `sandbox`:
 * its `codemode` tool says how to write a program, its prompt section
 * declares the tools a program may call, and each script runs wrapped so
 * `tools` holds what the section declares.
 */
export const makeExtension = (
  sandbox: CodemodeSandboxBase,
  convention: Convention,
  /** Every tool a program may call, by its name where scripts run. */
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

    const section: PromptSection = {
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
    };

    return {
      ...extension,
      name: CODEMODE_EXTENSION,
      tools: (extension.tools ?? []).map((tool: ToolRegistration) =>
        tool.name === CODEMODE_TOOL
          ? {
              ...tool,
              // Keep Pi's globals; replace how scripts are written.
              description: [convention.intro, ...tool.description.split("\n\n").slice(1)].join(
                "\n\n",
              ),
            }
          : tool,
      ),
      sections: [section],
    };
  });
