/**
 * Control refs render their model-facing prose IN PLACE (reassess §A):
 * before this, `displayRef` returned "" for every control ref and the
 * budget was never shown to the model at all. These tests pin that the
 * halt contract, budget ceilings, concurrency, and triggers now appear
 * in the rendered charter where the author interpolated them.
 */
import { describe, expect, it } from "@effect/vitest";
import * as S from "effect/Schema";
import * as AI from "@/AI/index.ts";

describe("control refs render in place", () => {
  it("AI.until renders the halt contract where it sits", () => {
    class Compute extends AI.Process<Compute>()("Compute")`
Compute the expression.
${AI.until(S.Struct({ answer: S.Number }))`the expression is fully evaluated`}` {}

    const prose = AI.renderTemplate(
      (Compute as any).template,
      (Compute as any).refs,
    );
    expect(prose).toContain("Compute the expression.");
    // the halt condition is now VISIBLE to the model, in place
    expect(prose).toContain("# Halt condition");
    expect(prose).toContain("the expression is fully evaluated");
    expect(prose).toContain("call the `resolve` tool");
    // schema present ⇒ the result-value clause
    expect(prose).toContain("with the result value");
  });

  it("AI.never renders the perpetual health note", () => {
    class Watch extends AI.Process<Watch>()("Watch")`
Watch the queue. ${AI.never`one ack per item`}` {}
    const prose = AI.renderTemplate(
      (Watch as any).template,
      (Watch as any).refs,
    );
    expect(prose).toContain("perpetual ring");
    expect(prose).toContain("one ack per item");
  });

  it("AI.budget renders the ceilings (previously invisible to the model)", () => {
    class Fix extends AI.Process<Fix>()("Fix")`
Fix it. ${AI.until(S.String)`green`} ${AI.budget({ iterations: 8, tokens: "5M" })}` {}
    const prose = AI.renderTemplate((Fix as any).template, (Fix as any).refs);
    expect(prose).toContain("# Budget");
    expect(prose).toContain("at most 8 iterations");
    expect(prose).toContain("5M tokens");
  });

  it("AI.concurrency renders inline as its value", () => {
    const item = AI.Parameter("item", S.String)`a work item`;
    class Fan extends AI.Process<Fan>()("Fan")`
Serve items, ${AI.concurrency(3)}. ${AI.never`healthy`} ${AI.each(item)}` {}
    const prose = AI.renderTemplate((Fan as any).template, (Fan as any).refs);
    expect(prose).toContain("at most 3 in flight");
  });

  it("Tools and agents still render as their names; Observe stays silent", () => {
    const q = AI.Parameter("q", S.String)`the query`;
    class Search extends AI.Tool<Search>()("search")`Search for ${q}.` {}
    class Helper extends AI.Agent<Helper>()("Helper")`You help.` {}
    class Watch extends AI.Process<Watch>()("Watch")`Watch it.` {}
    class Boss extends AI.Process<Boss>()("Boss")`
Use ${Search}, delegate to ${Helper}, watch ${AI.observe(Watch)}.
${AI.never`healthy`}` {}
    const prose = AI.renderTemplate((Boss as any).template, (Boss as any).refs);
    expect(prose).toContain("Use search");
    expect(prose).toContain("delegate to Helper");
    // observe grants trace access, not a prose mention of the subject
    expect(prose).toContain("watch .");
  });
});
