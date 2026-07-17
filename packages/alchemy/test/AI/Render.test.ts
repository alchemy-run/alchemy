/**
 * Signature/control refs render their model-facing prose IN PLACE
 * (reassess §A): these tests pin that the halt contract, concurrency,
 * and accepted messages appear in the rendered charter where the author
 * interpolated them. (Budget is NOT prose — `AI.budget({...})` is a
 * Layer the kernel enforces; nothing renders.)
 */
import { describe, expect, it } from "@effect/vitest";
import * as S from "effect/Schema";
import * as AI from "@/AI/index.ts";
import * as GitHub from "@/GitHub/index.ts";
import { ResolveGitHubIssue } from "./fixtures/org/processes.ts";

// the deferred resource form — its declared identity (owner/name) is
// readable statically, so clauses render the real owner/repo
const repo = GitHub.Repository("render-test-alchemy", {
  owner: "alchemy-run",
  name: "test-alchemy",
});

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

  it("budget is not prose: nothing budget-shaped renders in a charter", () => {
    class Fix extends AI.Process<Fix>()("Fix")`
Fix it. ${AI.until(S.String)`green`}` {}
    const prose = AI.renderTemplate((Fix as any).template, (Fix as any).refs);
    // ceilings are provided as a Layer (AI.budget({...})) and enforced
    // by the kernel — the charter carries no budget block
    expect(prose).not.toContain("# Budget");
  });

  it("AI.concurrency renders inline as its value", () => {
    class Fan extends AI.Process<Fan>()("Fan")`
Serve items, ${AI.concurrency(3)}. ${AI.never`healthy`}` {}
    const prose = AI.renderTemplate((Fan as any).template, (Fan as any).refs);
    expect(prose).toContain("at most 3 in flight");
  });

  it("AI.when renders as the sentence's conjunction", () => {
    const Ping = AI.EventSource("test.ping", S.Struct({ n: S.Number }));
    const Pong = AI.EventSource("test.pong", S.Struct({ n: S.Number }));
    class Serve extends AI.Process<Serve>()("Serve")`
${AI.when(Ping, Pong)} serve it. ${AI.never`healthy`}` {}
    const prose = AI.renderTemplate(
      (Serve as any).template,
      (Serve as any).refs,
    );
    expect(prose).toContain("when test.ping or test.pong arrives serve it.");
  });

  it("a bare event mention (the publish grant) renders the event's name in place", () => {
    const FixShipped = AI.EventSource(
      "fix.shipped",
      S.Struct({ pr: S.Number }),
    );
    class Fixer extends AI.Process<Fixer>()("Fixer")`
Ship fixes; publish ${FixShipped} for each.
${AI.never`healthy`}` {}
    const prose = AI.renderTemplate(
      (Fixer as any).template,
      (Fixer as any).refs,
    );
    // the mention renders as the event's name, like a Tool mention
    expect(prose).toContain("publish fix.shipped for each.");
  });

  it("${X.name} interpolates a plain string — the inert mention", () => {
    const FixShipped = AI.EventSource(
      "fix.shipped",
      S.Struct({ pr: S.Number }),
    );
    class Reader extends AI.Process<Reader>()("Reader")`
You may hear about ${FixShipped.name} but you never publish it.
${AI.never`healthy`}` {}
    const prose = AI.renderTemplate(
      (Reader as any).template,
      (Reader as any).refs,
    );
    expect(prose).toContain("hear about fix.shipped but");
    // a string ref is inert: nothing joins the published language
    expect(AI.topology(Reader)[0]!.emits).toEqual([]);
  });

  it("a description-bearing when renders the clause verbatim, no 'arrives'", () => {
    class Desk extends AI.Process<Desk>()("RenderDesk")`
${AI.when(GitHub.IssueOpened(repo))}, read it first. ${AI.never`healthy`}` {}
    const prose = AI.renderTemplate((Desk as any).template, (Desk as any).refs);
    expect(prose).toContain(
      "when an issue opens in alchemy-run/test-alchemy, read it first.",
    );
    expect(prose).not.toContain("arrives");
  });

  it("a mixed when uses descriptions where present, '{name} arrives' where not", () => {
    const Nudge = AI.EventSource("org.nudge", S.Struct({ n: S.Number }));
    class Desk extends AI.Process<Desk>()("RenderMixedDesk")`
${AI.when(GitHub.IssueOpened(repo), Nudge)} act on it. ${AI.never`healthy`}` {}
    const prose = AI.renderTemplate((Desk as any).template, (Desk as any).refs);
    expect(prose).toContain(
      "when an issue opens in alchemy-run/test-alchemy or org.nudge arrives act on it.",
    );
  });

  it("a bare mention renders only the NAME — descriptions never leak into noun position", () => {
    class Talker extends AI.Process<Talker>()("RenderTalker")`
${GitHub.IssueOpened(repo)} is vocabulary here. ${AI.never`healthy`}` {}
    const prose = AI.renderTemplate(
      (Talker as any).template,
      (Talker as any).refs,
    );
    expect(prose).toContain(
      "github.issues.opened/alchemy-run/test-alchemy is vocabulary here.",
    );
    expect(prose).not.toContain("an issue opens");
  });

  it("a machine-observed exit renders the source's description as the exit clause", () => {
    class Case extends AI.Process<Case>()("RenderCase")`
Work the issue.
${AI.exit(AI.when(GitHub.IssueClosed(repo)))}` {}
    const prose = AI.renderTemplate((Case as any).template, (Case as any).refs);
    expect(prose).toContain(
      "This run ends when: GitHub closes an issue in alchemy-run/test-alchemy",
    );
  });

  it("a prose-carrying exit joins the clause and the authored prose with an em dash", () => {
    class Case extends AI.Process<Case>()("RenderProseCase")`
Work the issue.
${AI.exit(AI.when(GitHub.IssueClosed(repo)))`whether merged or by hand`}` {}
    const prose = AI.renderTemplate((Case as any).template, (Case as any).refs);
    expect(prose).toContain(
      "This run ends when: GitHub closes an issue in alchemy-run/test-alchemy — whether merged or by hand",
    );
  });

  it("a prose-carrying exit on a description-less source falls back to '{name} arrives'", () => {
    const Done = AI.EventSource("test.done", S.Struct({ n: S.Number }));
    class Case extends AI.Process<Case>()("RenderFallbackCase")`
Work it. ${AI.exit(AI.when(Done))`one way or another`}` {}
    const prose = AI.renderTemplate((Case as any).template, (Case as any).refs);
    expect(prose).toContain(
      "This run ends when: test.done arrives — one way or another",
    );
  });

  it("a multi-source exit joins the sources' clauses with ' or '", () => {
    class Case extends AI.Process<Case>()("RenderMultiCase")`
Work the issue.
${AI.exit(AI.when(GitHub.IssueClosed(repo), GitHub.PullRequestMerged(repo)))}` {}
    const prose = AI.renderTemplate((Case as any).template, (Case as any).refs);
    expect(prose).toContain(
      "This run ends when: GitHub closes an issue in alchemy-run/test-alchemy or a pull request merges in alchemy-run/test-alchemy",
    );
  });

  it("the fixture charter renders as readable prose (deferred repo ⇒ real identity)", () => {
    // normalize the template's line wraps so assertions read as sentences
    const prose = AI.renderTemplate(
      (ResolveGitHubIssue as any).template,
      (ResolveGitHubIssue as any).refs,
    ).replace(/\s+/g, " ");
    // the deferred (un-yielded resource) form carries its declared
    // identity statically — clauses name the real owner/repo
    expect(prose).toContain(
      "when an issue opens in alchemy-run/test-alchemy, read it, then searchIssues for",
    );
    expect(prose).toContain(
      "when a comment lands on an issue in alchemy-run/test-alchemy, read it and adjust",
    );
    // tools compose as the sentence's verb (prose guide: never "reply
    // with ${Reply}" — the mention IS the action)
    expect(prose).toContain("comment asking the reporter to close it");
    expect(prose).toContain("Once approved, mergePullRequest —");
    // the machine exit composes the source's clause with the charter's
    // authored prose — no lead-in restatement anywhere in the charter
    expect(prose).toContain(
      "This run ends when: GitHub closes an issue in alchemy-run/test-alchemy — whether the merged pull request closed it or a maintainer closed it by hand",
    );
    expect(prose).not.toContain("is what ends your work");
    // budget is a Layer, not prose
    expect(prose).not.toContain("# Budget");
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
