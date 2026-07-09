/**
 * The org stress test: one contrived problem that CANNOT be solved
 * without the whole machinery working together.
 *
 * The Vault Hunt: a 3-factor vault code is split across three scouts.
 * Each scout holds a private `consult_archive` tool — same contract,
 * three different Layer physics (per-agent tool isolation) — and the
 * Coordinator has NO archive access at all (capability denial by
 * omission: its charter never interpolates the tool, so no Layer can
 * grant it). To resolve, the Coordinator must:
 *
 *   1. spawn Scout Alpha in the BACKGROUND (§2.8 spawn-and-continue)
 *   2. call Scouts Bravo and Charlie synchronously (delegation)
 *   3. join Alpha via `wait_run` (§2.8c — the Ask-shaped park)
 *   4. multiply the three clues
 *   5. request human approval — a real Ask park the test answers
 *   6. resolve with the code — graded by a MACHINE check (§2.9's
 *      deterministic oracle) before it is believed
 *
 * all inside an iteration budget, on one shared live model.
 *
 *   ANTHROPIC_API_KEY=sk-… bun vitest run test/AI/OrgStress.test.ts
 */
import * as AnthropicClient from "@effect/ai-anthropic/AnthropicClient";
import * as AnthropicLanguageModel from "@effect/ai-anthropic/AnthropicLanguageModel";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as S from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as AI from "@/AI/index.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";

const apiKey = process.env.ANTHROPIC_API_KEY;

// ─── the vocabulary ──────────────────────────────────────────────

const query = AI.Parameter("query", S.String)`what you are looking for`;
const action = AI.Parameter("action", S.String)`the action needing approval`;

// ─── ONE tool contract, THREE physics (per-agent isolation) ──────

class ConsultArchive extends AI.Tool<ConsultArchive>()("consult_archive")`
Consult your private archive for ${query}. Returns your secret clue
number. Only YOU can read your own archive.` {}

class RequestApproval extends AI.Tool<RequestApproval>()("request_approval")`
Request the vault-keeper's approval for ${action}. Blocks until the
decision arrives. NEVER open the vault without it.` {}

// ─── the scouts: same charter, distinct tags, distinct physics ───

class ScoutAlpha extends AI.Agent<ScoutAlpha>()("ScoutAlpha")`
You are Scout Alpha. For any task, consult ${ConsultArchive} and report
your clue number in plain digits.` {}

class ScoutBravo extends AI.Agent<ScoutBravo>()("ScoutBravo")`
You are Scout Bravo. For any task, consult ${ConsultArchive} and report
your clue number in plain digits.` {}

class ScoutCharlie extends AI.Agent<ScoutCharlie>()("ScoutCharlie")`
You are Scout Charlie. For any task, consult ${ConsultArchive} and
report your clue number in plain digits.` {}

// ─── the coordinator: no archive access, must collaborate ────────

/**
 * The vault door — a MACHINE check enforcing both the ANSWER (the code)
 * and the PROCESS (approval happened before resolving). §2.9 in action:
 * the charter's "only after approval" is worker discretion the model may
 * (and, live, does) skip; the guarantee lives in the deterministic
 * oracle, which rejects unapproved resolutions with actionable feedback.
 */
const vaultDoor =
  (state: {
    approved: boolean;
  }): ((input: AI.CheckInput) => Effect.Effect<AI.CheckVerdict>) =>
  (input) =>
    Effect.sync(() => {
      if (!state.approved) {
        return {
          verdict: "off-goal",
          reason:
            "the vault-keeper has NOT approved the opening — call " +
            "request_approval with the code first, then resolve again",
        };
      }
      return (input.claim as { code: number }).code === 3 * 5 * 7
        ? { verdict: "goal-met" }
        : {
            verdict: "off-goal",
            reason:
              "that is not the vault code — re-check each scout's clue " +
              "and multiply exactly the three numbers",
          };
    });

/** Shared vault state: the approval flips it, the door checks it. */
const vault = { approved: false };

class Coordinator extends AI.Loop<Coordinator>()("Coordinator")`
You coordinate a vault hunt. You have NO archive access of your own —
the three clue numbers are held by ${ScoutAlpha}, ${ScoutBravo}, and
${ScoutCharlie}, one each.

Work EXACTLY like this:
1. Delegate to ScoutAlpha with background=true (it is slow; let it work).
2. Delegate to ScoutBravo synchronously, then ScoutCharlie synchronously.
3. Join ScoutAlpha's result with wait_run (its run key came back in
   step 1).
4. The vault code is the PRODUCT of the three clue numbers.
5. Request approval via ${RequestApproval} with the action
   "open the vault with code <code>".
6. Only after approval, call resolve with the code.
${AI.until(S.Struct({ code: S.Number }))`the vault code is assembled and approved`}
${AI.check(vaultDoor(vault))}
${AI.budget({ iterations: 8 })}` {}

// ─── physics ─────────────────────────────────────────────────────

const ModelLive = AnthropicLanguageModel.layer({
  model: "claude-haiku-4-5",
}).pipe(
  Layer.provide(
    AnthropicClient.layer({
      apiKey: apiKey === undefined ? undefined : Redacted.make(apiKey),
    }),
  ),
  Layer.provide(FetchHttpClient.layer),
);

/** A scout's private archive: records consultations, returns its clue. */
const archive = (clue: number, log: number[]) =>
  Layer.succeed(ConsultArchive, ((_input: { query: string }) =>
    Effect.sync(() => {
      log.push(clue);
      return `your secret clue number is ${clue}`;
    })) as never);

/** Approval via the Ask protocol — ordinary user code over the seam.
 * An approval flips the vault's shared state, which the machine check
 * reads: the PROCESS guarantee is closed end to end. */
const ApprovalViaAsk = Layer.succeed(RequestApproval, ((input: {
  action: string;
}) =>
  Effect.gen(function* () {
    const ask = yield* AI.Ask;
    const answer = yield* ask({ kind: "approval", text: input.action });
    if (answer.verdict !== "approved") {
      return yield* Effect.fail(`denied: ${answer.text ?? "no reason"}`);
    }
    vault.approved = true;
    return "approved — you may open the vault";
  })) as never);

// ─── the hunt ────────────────────────────────────────────────────

describe("the org stress test", () => {
  // it.live: the pending-ask poll waits on the real clock
  it.live.skipIf(apiKey === undefined)(
    "three scouts, one coordinator, a park, and a machine oracle",
    () =>
      Effect.gen(function* () {
        vault.approved = false; // fresh vault per attempt (retries)
        const consultations = {
          alpha: [] as number[],
          bravo: [] as number[],
          charlie: [] as number[],
        };
        // the hub Layer must reach BOTH the kernel (the asking side) and
        // the test scope (the answering side) — Layer memoization makes
        // the shared reference one instance
        const kernelLayer = AI.memory.pipe(
          Layer.provide([ModelLive, AI.AskHubMemory]),
        );
        // three rings, one tool contract, three different physics
        const ScoutAlphaLive = AI.layer(ScoutAlpha).pipe(
          Layer.provide([
            kernelLayer,
            archive(3, consultations.alpha),
            RuntimeContext.phantom,
          ]),
        );
        const ScoutBravoLive = AI.layer(ScoutBravo).pipe(
          Layer.provide([
            kernelLayer,
            archive(5, consultations.bravo),
            RuntimeContext.phantom,
          ]),
        );
        const ScoutCharlieLive = AI.layer(ScoutCharlie).pipe(
          Layer.provide([
            kernelLayer,
            archive(7, consultations.charlie),
            RuntimeContext.phantom,
          ]),
        );

        const { result, trace } = yield* Effect.scoped(
          Effect.gen(function* () {
            const kernel = yield* AI.Kernel;
            const hub = yield* AI.AskHub;
            const coordinator = yield* kernel.interpret(Coordinator);

            const running = yield* Effect.forkChild(
              coordinator.dispatch(
                "Assemble the vault code and get it approved.",
              ),
            );
            // the vault-keeper's side of the Ask: wait for the park,
            // verify what is being approved, then approve. Raced against
            // the run itself so a run that ends WITHOUT asking surfaces
            // its real outcome instead of a poll timeout.
            const pending = yield* Effect.raceFirst(
              hub.pending.pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("500 millis"),
                  until: (asks) => asks.length > 0,
                  times: 200,
                }),
              ),
              Fiber.join(running).pipe(
                Effect.flatMap((outcome) =>
                  Effect.die(
                    new Error(
                      `the run ended without ever asking: ${JSON.stringify(outcome)}`,
                    ),
                  ),
                ),
              ),
            );
            expect(pending[0]!.ring).toBe("Coordinator");
            expect(pending[0]!.payload.text).toContain("105");
            yield* hub.answer(pending[0]!.id, { verdict: "approved" });

            const result = yield* Fiber.join(running);
            const trace = yield* Stream.runCollect(
              kernel
                .trace("Coordinator")
                .pipe(
                  Stream.takeUntil((event) => event.type === "run.resolved"),
                ),
            );
            return { result, trace };
          }),
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              kernelLayer,
              ScoutAlphaLive,
              ScoutBravoLive,
              ScoutCharlieLive,
              ApprovalViaAsk,
              AI.AskHubMemory,
              RuntimeContext.phantom,
            ),
          ),
        );

        // the typed, machine-ratified result came back up the topology
        expect(result).toEqual({ code: 105 });

        // every scout consulted its OWN archive (per-agent physics)
        expect(consultations.alpha).toContain(3);
        expect(consultations.bravo).toContain(5);
        expect(consultations.charlie).toContain(7);

        // the coordinator's Trace shows the full §2.8/§2.4 choreography:
        const toolRequests = trace
          .filter((event) => event.type === "tool.requested")
          .map((event) => (event.payload as { name: string }).name);
        // …all three delegations…
        expect(toolRequests).toContain("ScoutAlpha");
        expect(toolRequests).toContain("ScoutBravo");
        expect(toolRequests).toContain("ScoutCharlie");
        // …the background run's result was collected by ONE of the two
        // §2.8 paths: an explicit wait_run join, or the completion steer
        // promoted at a boundary (both legitimate; the model chooses)…
        const types = trace.map((event) => event.type);
        expect(
          toolRequests.includes("wait_run") || types.includes("turn.steered"),
        ).toBe(true);
        // …and the Ask park, requested before answered
        expect(types.indexOf("ask.requested")).toBeGreaterThan(-1);
        expect(types.indexOf("ask.requested")).toBeLessThan(
          types.indexOf("ask.answered"),
        );
        // the machine oracle graded the claim before it was believed
        expect(types.indexOf("check.verdict")).toBeLessThan(
          types.indexOf("run.resolved"),
        );
      }),
    { timeout: 300_000 },
  );
});
