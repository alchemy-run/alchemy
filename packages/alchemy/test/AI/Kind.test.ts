/**
 * User-defined Process kinds (org-chat §2.5): a kind is a macro plus
 * metadata — it lowers to a plain Process (charter scaffolding spliced
 * around instance prose), carries subkind + meta for topology, and the
 * kernel interprets instances with zero knowledge of the kind.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import * as Stream from "effect/Stream";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import type * as Response from "effect/unstable/ai/Response";
import * as AI from "@/AI/index.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";

// ─── a toy kind ──────────────────────────────────────────────────

const notice = AI.Parameter("notice", S.String)`what to announce`;
class Announce extends AI.Tool<Announce>()("announce")`
Post ${notice} to the room.` {}

class Scout extends AI.Agent<Scout>()("Scout")`
You answer fast and flag uncertainty.` {}

const Channel = AI.Process("Channel", {
  charter: (name: string) => AI.charter`
You are the #${name} channel. Decide how the room responds. ${AI.body}
Always ${Announce} once before resolving.
${AI.until(S.String)`the post is resolved — resolve with a one-line summary`}
${AI.budget({ iterations: 4 })}`,
  meta: { category: "channel", icon: "hash" },
});

class General extends Channel<General>()("general")`
Casual chat for everyone. ${Scout} hangs out here.` {}

describe("Process kinds", () => {
  it("an instance lowers to a plain Process with composed prose + refs", () => {
    expect(AI.isProcess(General)).toBe(true);
    expect((General as any)["~alchemy/Kind"]).toBe("Process");
    expect((General as any)["~alchemy/Subkind"]).toBe("Channel");
    expect((General as any)["~alchemy/Meta"]).toEqual({
      category: "channel",
      icon: "hash",
    });

    // scaffold prose + instance prose, spliced in order
    const prose = AI.renderTemplate(
      (General as any).template,
      (General as any).refs,
    );
    expect(prose).toContain("You are the #general channel");
    expect(prose).toContain("Casual chat for everyone. Scout hangs out");
    expect(prose.indexOf("You are the #general")).toBeLessThan(
      prose.indexOf("Casual chat"),
    );
    expect(prose.indexOf("Casual chat")).toBeLessThan(
      prose.indexOf("Always announce once"),
    );

    // refs are scaffold ∪ instance: the halt, budget, tool AND the member
    const refs = (General as any).refs as unknown[];
    expect(refs.some((ref) => ref === Scout)).toBe(true);
    expect(refs.some((ref) => ref === Announce)).toBe(true);
    expect(refs.some((ref) => AI.isHalt(ref))).toBe(true);
  });

  it("an instance with NO refs still splices correctly", () => {
    class Quiet extends Channel<Quiet>()("quiet")`Silence, mostly.` {}
    const prose = AI.renderTemplate(
      (Quiet as any).template,
      (Quiet as any).refs,
    );
    expect(prose).toContain("#quiet channel");
    expect(prose).toContain("Silence, mostly.");
    expect(prose).toContain("Always announce once");
  });

  it("a scaffold without ${AI.body} is a constructor error", () => {
    const Broken = AI.Process("Broken", {
      charter: () => AI.charter`no splice point here`,
    });
    expect(() => {
      class Nope extends Broken<Nope>()("nope")`instance prose` {}
      void Nope;
    }).toThrow(/AI\.body/);
  });

  it.effect(
    "the kernel interprets a kind instance with zero kind knowledge",
    () => {
      // scripted: the model resolves immediately after announcing
      const usage = {
        inputTokens: {
          uncached: undefined,
          total: 1,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      };
      let calls = 0;
      const script: Array<Array<Record<string, unknown>>> = [
        [
          {
            type: "tool-call",
            id: "c1",
            name: "announce",
            params: { notice: "on it" },
            providerExecuted: false,
          },
          { type: "finish", reason: "tool-calls", usage, response: undefined },
        ],
        [
          {
            type: "tool-call",
            id: "c2",
            name: "resolve",
            params: { value: JSON.stringify("handled: greeted the user") },
            providerExecuted: false,
          },
          { type: "finish", reason: "tool-calls", usage, response: undefined },
        ],
      ];
      const model = Layer.effect(
        LanguageModel.LanguageModel,
        LanguageModel.make({
          generateText: () => Effect.die(new Error("streamText only")),
          streamText: () =>
            Stream.fromIterable(
              (script[calls++] ??
                []) as unknown as Array<Response.StreamPartEncoded>,
            ),
        }),
      );
      const announced: string[] = [];

      return Effect.gen(function* () {
        const kernel = yield* AI.Kernel;
        const general = yield* kernel.interpret(General);
        const outcome = yield* general.dispatch("hello room");
        expect(outcome).toBe("handled: greeted the user");
        expect(announced).toEqual(["on it"]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            AI.memory.pipe(Layer.provide(model)),
            Layer.succeed(Announce, ((input: { notice: string }) =>
              Effect.sync(() => {
                announced.push(input.notice);
                return "posted";
              })) as never),
            // the member's tag is a real requirement (Req = Scout | Announce
            // — derived from the COMPOSED refs); the script never delegates,
            // so a stub satisfies it
            Layer.succeed(Scout, {
              dispatch: () => Effect.die(new Error("unused")),
              send: () => Effect.void,
              run: () => Effect.die(new Error("unused")),
              steer: () => Effect.void,
              interrupt: () => Effect.void,
            } as never),
            RuntimeContext.phantom,
          ),
        ),
      );
    },
  );
});

describe("AI.topology", () => {
  it("derives the org graph from interpolation, statically", () => {
    const [node] = AI.topology(General);
    expect(node).toMatchObject({
      name: "general",
      kind: "process",
      subkind: "Channel",
      meta: { category: "channel", icon: "hash" },
    });
    // members = interpolated agents; capabilities = interpolated tools
    expect(node!.children.map((child) => child.name)).toEqual(["Scout"]);
    expect(node!.children[0]!.kind).toBe("agent");
    expect(node!.tools).toContain("announce");
    expect(node!.prose).toContain("#general channel");
  });

  it("agents can be roots (DM targets) and non-terms are skipped", () => {
    const nodes = AI.topology(Scout, "not a term", General);
    expect(nodes.map((node) => `${node.kind}:${node.name}`)).toEqual([
      "agent:Scout",
      "process:general",
    ]);
  });
});
