import * as AI from "@alchemy.run/ai";
import { makeHarness } from "@alchemy.run/ai/Harness";
import { callTool, type ToolHandler, type ToolSpec } from "@alchemy.run/ai/Tool";
import * as Effect from "effect/Effect";

/** What a recording harness was asked to run. */
interface Recorded {
  readonly instructions: string;
  readonly tools: ReadonlyArray<string>;
  /** The model the session was opened on. */
  model: string;
  readonly messages: Array<{
    readonly text: string;
    readonly requestId?: string;
    readonly model?: string;
  }>;
}

/** An `AI.Harness` that runs nothing: it keeps what each session was given. */
export const recording = () => {
  const sessions = new Map<string, Recorded>();
  const tools = new Map<string, { spec: ToolSpec; handler: ToolHandler<ToolSpec> }>();
  const values = new Map<string, string>();
  const opened: Array<{ models: ReadonlyArray<string>; tools: ReadonlyArray<string> }> = [];
  const toolName = (tool: unknown) => (tool as { toolName: string }).toolName;
  const layer = makeHarness<never>("recording", (options) =>
    Effect.sync(() => {
      opened.push({
        models: options.models.map((model) => model.modelName),
        tools: options.tools.map(toolName),
      });
      for (const tool of options.tools) {
        const { spec, handler } = tool as { spec?: ToolSpec; handler?: ToolHandler<ToolSpec> };
        if (spec !== undefined && handler !== undefined)
          tools.set(toolName(tool), { spec, handler });
      }
      return {
        values: {
          get: (key) => Effect.sync(() => values.get(key)),
          put: (key, value) => Effect.sync(() => void values.set(key, value)),
        },
        toolName: (tool) => `rec_${toolName(tool)}`,
        session: (name, options) => {
          const record = (opened?: AI.AnyModel) => {
            let session = sessions.get(name);
            if (session === undefined) {
              session = {
                instructions: options.instructions,
                tools: options.tools.map(toolName),
                model: (opened ?? options.model).modelName,
                messages: [],
              };
              sessions.set(name, session);
            }
            return session;
          };
          const submit = (text: string, sent?: AI.SendOptions) =>
            Effect.sync(() => {
              const session = record();
              if (sent?.requestId !== undefined) {
                if (session.messages.some((message) => message.requestId === sent.requestId)) {
                  return;
                }
              }
              session.messages.push({
                text,
                ...(sent?.requestId === undefined ? {} : { requestId: sent.requestId }),
                model: sent?.model?.modelName ?? session.model,
              });
            });
          return {
            exists: Effect.sync(() => sessions.has(name)),
            // A tool call of this harness carries the session's name.
            open: (opened) => Effect.sync(() => (record(opened?.model), name)),
            submit,
            prompt: (text, sent) => Effect.as(submit(text, sent), { text: `echo: ${text}` }),
            wait: Effect.void,
            abort: Effect.void,
            messages: Effect.sync(() => sessions.get(name)?.messages ?? []),
          };
        },
      };
    }),
  );
  /**
   * Call a tool the way a harness does: JSON arguments in, and what the
   * model would read out (`structured` is the value, `isError` a declared failure).
   */
  const call = (name: string, parameters: unknown, callId = "call-1", conversationId = "c") =>
    Effect.suspend(() => {
      const tool = tools.get(name)!;
      return callTool(tool.spec, tool.handler, parameters);
    }).pipe(
      Effect.provideService(AI.ToolCall, { conversationId, callId }),
      // The recording harness never opens a sandbox.
      Effect.provideService(AI.Sandbox, undefined as never),
    );
  return { layer, sessions, opened, values, call };
};
