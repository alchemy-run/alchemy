/**
 * Conformance tests for the pure step machine (design §2.4, build-order
 * step 3): determinism, serializability-by-construction, the
 * truncated-batch rule, steering promotion at the boundary, call-order
 * result appending, and per-command ceiling checks.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Prompt from "effect/unstable/ai/Prompt";
import * as AI from "@/AI/index.ts";

const { Step } = AI;

const userInput = (text: string): Prompt.Message =>
  Prompt.makeMessage("user", {
    content: [Prompt.makePart("text", { text })],
  });

const dispatched = (text: string): AI.Step.Feedback => ({
  _tag: "Dispatched",
  input: [userInput(text)],
});

const modelSays = (
  commandId: string,
  outcome: Partial<AI.Step.ModelOutcome>,
): AI.Step.Feedback => ({
  _tag: "ModelResponse",
  commandId,
  outcome: {
    text: outcome.text ?? "",
    toolCalls: outcome.toolCalls ?? [],
    finishReason: outcome.finishReason ?? "stop",
    tokens: outcome.tokens,
  },
});

/** Drive a scripted session; returns every [state, commands] transition. */
const run = (feedbacks: ReadonlyArray<AI.Step.Feedback>) => {
  let state = Step.initialState({ session: "hash:issue-1" });
  const transitions: Array<{
    state: AI.Step.StepState;
    commands: ReadonlyArray<AI.Step.Command>;
  }> = [];
  for (const feedback of feedbacks) {
    const [next, commands] = Step.step(state, feedback);
    transitions.push({ state: next, commands });
    state = next;
  }
  return transitions;
};

describe("the pure step machine", () => {
  it("dispatch → CallModel; no tool calls → Completed halt", () => {
    const [first, second] = run([
      dispatched("hello"),
      modelSays("cmd:hash:issue-1:1:0", { text: "hi there" }),
    ]);
    expect(first!.commands).toHaveLength(1);
    expect(first!.commands[0]!._tag).toBe("CallModel");
    expect(second!.commands[0]).toMatchObject({
      _tag: "Halt",
      outcome: { _tag: "Completed", text: "hi there" },
    });
    expect(second!.state.phase).toBe("halted");
  });

  it("tool calls dispatch as commands; results append in CALL order", () => {
    const calls = [
      { callId: "c1", name: "grep", params: { pattern: "x" } },
      { callId: "c2", name: "read", params: { path: "y" } },
    ];
    const transitions = run([
      dispatched("work"),
      modelSays("m1", { toolCalls: calls, finishReason: "tool-calls" }),
      // settle OUT of call order
      { _tag: "ToolSettled", callId: "c2", isFailure: false, result: "r2" },
      { _tag: "ToolSettled", callId: "c1", isFailure: false, result: "r1" },
    ]);
    expect(transitions[1]!.commands.map((c) => c._tag)).toEqual([
      "CallTool",
      "CallTool",
    ]);
    // batch completes on the second settlement → next CallModel
    const roundTwo = transitions[3]!.commands[0]!;
    expect(roundTwo._tag).toBe("CallModel");
    const toolMessage = (roundTwo as any).messages.find(
      (m: Prompt.Message) => m.role === "tool",
    );
    const ids = toolMessage.content.map((p: any) => p.id);
    expect(ids).toEqual(["c1", "c2"]); // call order, not settlement order
  });

  it("truncated batches fail wholesale and are model-visible", () => {
    const transitions = run([
      dispatched("work"),
      modelSays("m1", {
        toolCalls: [{ callId: "c1", name: "bash", params: {} }],
        finishReason: "length",
      }),
    ]);
    // no CallTool was issued; the machine went straight to the next round
    const commands = transitions[1]!.commands;
    expect(commands.map((c) => c._tag)).toEqual(["CallModel"]);
    const prompt = (commands[0] as any).messages as Prompt.Message[];
    const results = prompt
      .flatMap((m) => m.content as any[])
      .filter((p) => p.type === "tool-result");
    expect(results).toHaveLength(1);
    expect(results[0]!.isFailure).toBe(true);
    expect(results[0]!.result).toBe(AI.SYNTHETIC_ABORTED);
  });

  it("steers are held, then promoted at the next boundary", () => {
    const steer: AI.Step.Feedback = {
      _tag: "Steered",
      messages: [userInput("actually, stop refactoring")],
    };
    const transitions = run([
      dispatched("work"),
      steer, // arrives mid-turn: held, no commands
      modelSays("m1", {
        toolCalls: [{ callId: "c1", name: "bash", params: {} }],
        finishReason: "tool-calls",
      }),
      { _tag: "ToolSettled", callId: "c1", isFailure: false, result: "ok" },
    ]);
    expect(transitions[1]!.commands).toHaveLength(0); // held
    const nextRound = transitions[3]!.commands[0] as any;
    const texts = (nextRound.messages as Prompt.Message[])
      .flatMap((m) => m.content as any[])
      .filter((p) => p.type === "text")
      .map((p) => p.text);
    expect(texts).toContain("actually, stop refactoring"); // promoted
    expect(transitions[3]!.state.steerQueue).toHaveLength(0);
  });

  it("the model-call ceiling fires as a typed Halt, not an error", () => {
    let state = Step.initialState({ session: "s", maxModelCalls: 1 });
    const [afterDispatch, first] = Step.step(state, dispatched("go"));
    expect(first[0]!._tag).toBe("CallModel");
    const [, second] = Step.step(afterDispatch, {
      _tag: "ModelResponse",
      commandId: (first[0] as any).id,
      outcome: {
        text: "",
        toolCalls: [{ callId: "c1", name: "bash", params: {} }],
        finishReason: "tool-calls",
      },
    });
    // executing the batch would need a 2nd model call → ceiling instead…
    // (the batch is dispatched; the ceiling fires when its settlement
    // tries to construct round 2)
    expect(second.map((c) => c._tag)).toEqual(["CallTool"]);
    const [halted, third] = Step.step(
      {
        ...afterDispatch,
        pending: [{ callId: "c1", name: "bash", params: {} }],
        settled: [],
        modelCalls: 1,
      },
      { _tag: "ToolSettled", callId: "c1", isFailure: false, result: "ok" },
    );
    expect(third[0]).toMatchObject({
      _tag: "Halt",
      outcome: { _tag: "BudgetExceeded", limit: "modelCalls", budget: 1 },
    });
    expect(halted.phase).toBe("halted");
  });

  it("usage decrements transactionally; unknown usage is declared", () => {
    let state = Step.initialState({ session: "s" });
    [state] = Step.step(state, dispatched("go"));
    [state] = Step.step(
      state,
      modelSays("m1", {
        toolCalls: [{ callId: "c1", name: "bash", params: {} }],
        finishReason: "tool-calls",
        tokens: 120,
      }),
    );
    // the decrement landed in the SAME transition as the response
    expect(state.tokensUsed).toBe(120);
    expect(state.unknownUsage).toBe(0);
    [state] = Step.step(state, {
      _tag: "ToolSettled",
      callId: "c1",
      isFailure: false,
      result: "ok",
    });
    // a response with no reported usage is counted, never silently zero
    [state] = Step.step(state, modelSays("m2", { text: "done" }));
    expect(state.tokensUsed).toBe(120);
    expect(state.unknownUsage).toBe(1);
  });

  it("the token ceiling fires between commands as a typed Halt", () => {
    let state = Step.initialState({ session: "s", maxTokens: 100 });
    [state] = Step.step(state, dispatched("go")); // 0 < 100: round 1 allowed
    const [afterResponse, commands] = Step.step(
      state,
      modelSays("m1", {
        toolCalls: [{ callId: "c1", name: "bash", params: {} }],
        finishReason: "tool-calls",
        tokens: 150,
      }),
    );
    expect(commands.map((c) => c._tag)).toEqual(["CallTool"]); // batch runs
    const [halted, next] = Step.step(afterResponse, {
      _tag: "ToolSettled",
      callId: "c1",
      isFailure: false,
      result: "ok",
    });
    // round 2 would need the wire; the ceiling fires first
    expect(next[0]).toMatchObject({
      _tag: "Halt",
      outcome: {
        _tag: "BudgetExceeded",
        limit: "tokens",
        used: 150,
        budget: 100,
        unknownUsage: 0,
      },
    });
    expect(halted.phase).toBe("halted");
  });

  it("is deterministic and StepState survives structuredClone", () => {
    const script: ReadonlyArray<AI.Step.Feedback> = [
      dispatched("work"),
      modelSays("m1", {
        toolCalls: [{ callId: "c1", name: "bash", params: { a: 1 } }],
        finishReason: "tool-calls",
      }),
      { _tag: "ToolSettled", callId: "c1", isFailure: true, result: "boom" },
      modelSays("m2", { text: "done" }),
    ];
    const a = run(script);
    const b = run(script);
    expect(a).toEqual(b); // determinism

    for (const { state } of a) {
      // serializable by construction: no functions, no handles, no clocks.
      // (structuredClone drops the Prompt class prototypes but must not
      // throw; equality of the JSON projection is the invariant.)
      const clone = structuredClone(state);
      expect(JSON.parse(JSON.stringify(clone))).toEqual(
        JSON.parse(JSON.stringify(state)),
      );
    }
  });
});
