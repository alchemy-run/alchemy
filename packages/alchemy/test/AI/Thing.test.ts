/**
 * `AI.Thing` — the ontology term — and its direction markers: a bare
 * splice (or `AI.in(…)`) declares INPUT fields, `AI.out(…)` declares
 * the tool's RETURN record. Description and schema are one artifact
 * all the way to the wire: the compiled tool's parameters schema, its
 * success schema, and the rendered prose all come from the same
 * splices — which is what codemode's generated signatures (and the
 * type-checked impl return) hang off.
 */
import * as AI from "@/AI/index.ts";
import { renderSignature } from "@/AI/CodeMode.ts";
import { compileTool, getToolErrors, render } from "@/AI/DriverCore.ts";
import { describe, expect, it } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";
import * as AiTool from "effect/unstable/ai/Tool";

const q = AI.Thing("q", S.String)`
Substring to search for.`;

const limit = AI.Thing("limit", S.optionalKey(S.Int))`
Most rows to answer.`;

const title = AI.Thing("title", S.String)`
The entity's title.`;

const state = AI.Thing("state", S.Literals(["open", "closed"]))`
The entity's state.`;

const hits = AI.Thing("hits", S.Array(S.Struct({ id: S.String })))`
Matching rows, newest first.`;

describe("AI.Thing directions", () => {
  it("bare and AI.in splices are the tool's input schema", () => {
    const term = AI.Tool("search")`
      Search for ${q}, sized by ${AI.in(limit)}.
      Answers ${AI.out(hits)}.`;
    const tool = compileTool(term);
    const params = AiTool.getJsonSchema(tool) as {
      properties: Record<string, { description?: string }>;
      required?: string[];
    };
    expect(Object.keys(params.properties).sort()).toEqual(["limit", "q"]);
    expect(params.properties.q!.description).toBe("Substring to search for.");
    expect(params.required).toEqual(["q"]);
  });

  it("AI.out splices are the tool's return record", () => {
    const term = AI.Tool("search")`
      Search for ${q}. Answers ${AI.out(hits)}.`;
    const tool = compileTool(term);
    const returns = AiTool.getJsonSchemaFromSchema(
      (tool as any).successSchema,
    ) as {
      properties: Record<string, { description?: string }>;
      required?: string[];
    };
    expect(Object.keys(returns.properties)).toEqual(["hits"]);
    expect(returns.properties.hits!.description).toBe(
      "Matching rows, newest first.",
    );
  });

  it("variadic markers render as comma-joined names and fan into fields", () => {
    const term = AI.Tool("read_issue")`
      Read the issue — answers ${AI.out(title, state)}.`;
    expect(render(term.template, term.refs)).toBe(
      "Read the issue — answers `title`, `state`.",
    );
    const returns = AiTool.getJsonSchemaFromSchema(
      (compileTool(term) as any).successSchema,
    ) as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(returns.properties).sort()).toEqual(["state", "title"]);
    expect(returns.required?.sort()).toEqual(["state", "title"]);
  });

  it("the impl's return type is the record of the out-things", () => {
    // a compile-time fact, pinned here as one: the annotations below
    // fail `tsc -b` if ToolReturns drifts
    const term = AI.Tool("read_issue")`
      Answers ${AI.out(title, state)}.`;
    type Params = Parameters<(typeof term)["impl"]>[0];
    const impl: (p: Params) => {
      title: string;
      state: "open" | "closed";
    } = () => ({ title: "t", state: "open" });
    expect(impl({} as Params)).toEqual({ title: "t", state: "open" });
  });

  it("no declared output means the tool returns void", () => {
    const term = AI.Tool("mark_done")`
      Record that ${q} is done.`;
    // the wire: the success schema only admits undefined (S.Undefined,
    // not S.Void — Void would swallow failure payloads in the
    // failureMode:"return" result union)
    expect(((compileTool(term) as any).successSchema.ast as any)._tag).toBe(
      "Undefined",
    );
    // the types: the tool's declared success IS void — a consumer
    // cannot read a value out of an undeclared output (TS's usual
    // void-return leniency applies to the impl side, as everywhere)
    void term(() => Effect.void);
    type Success = AI.ToolReturns<(typeof term)["refs"][number]>;
    const _isVoid: [Success] extends [void] ? true : false = true;
    void _isVoid;
  });
});

describe("codemode signatures", () => {
  class NotFound extends Data.TaggedError("NotFound")<{
    message: string;
  }> {}

  const mentionOf = (term: AI.Tool<any, any>) => {
    const tool = compileTool(term);
    const successSchema = (tool as any).successSchema;
    return {
      name: term["~alchemy/Name"],
      description: AiTool.getDescription(tool) ?? "",
      parameters: AiTool.getJsonSchema(tool),
      returns:
        (successSchema?.ast?._tag ?? "") === "Undefined"
          ? { type: "void" }
          : AiTool.getJsonSchemaFromSchema(successSchema),
      errors: getToolErrors(tool),
      tool,
      handler: () => Effect.void,
    } as never;
  };

  it("the effect signature carries the return type and tagged error shapes", () => {
    const term = AI.Tool("read_issue")`
      Read the issue — answers ${AI.out(title, state)}.
      Fails with ${NotFound}.`;
    const signature = renderSignature(
      mentionOf(term),
      (returns, errors) => `Effect<${returns}, ${errors}>`,
    );
    expect(signature).toContain(
      'declare function read_issue(input: {}): Effect<{ title: string; state: "open" | "closed" }, { _tag: "NotFound" }>',
    );
  });

  it("an undeclared output renders as void, no declared errors as never", () => {
    const term = AI.Tool("mark_done")`
      Record that ${q} is done.`;
    const signature = renderSignature(
      mentionOf(term),
      (returns, errors) => `Effect<${returns}, ${errors}>`,
    );
    expect(signature).toContain(
      "declare function mark_done(input: { q: string }): Effect<void, never>",
    );
  });
});
