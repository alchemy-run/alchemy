/**
 * The DERIVED front door (canon §5, designs/ai/business-processes.md):
 * `GitHub.frontDoor(term)` walks a process term's declarations and
 * wires `consumeRepositoryEvents` underneath — adapt (Octokit wire →
 * distilled catalog shapes), then route by the virtual-actor rule
 * (first message for a case key ⇒ `send`; later ones ⇒ `steer(key, …)`;
 * unmatched deliveries are denial-by-skip).
 *
 * Scripted, no API key: a stubbed `RepositoryEventSource` captures the
 * one consume registration (props + handler) so the test injects
 * synthetic webhook deliveries. Door routing is asserted against a
 * recording ProcessService double; kernel integration is asserted
 * separately with the memory kernel + a deterministic `AI.process`
 * handler (the send door admits a real run — `run.admitted` in the
 * Trace).
 */
import * as AI from "@/AI/index.ts";
import * as GitHub from "@/GitHub/index.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import * as Stream from "effect/Stream";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";

const repo = { owner: "alchemy-run", repository: "alchemy-effect" };

// a tiny deterministic case term: two accepted messages, both on the
// GitHub channel; the halt is model-declared so the term itself holds
// no channel obligation (AI.when contributes nothing to Req)
class Desk extends AI.Process<Desk>()("FrontDoorDesk")`
${AI.when(GitHub.IssueOpened(repo))} a new issue opens the case.
${AI.when(GitHub.IssueCommented(repo))} a comment is the conversation
moving — steered to the running case.
${AI.until(S.String)`the case is answered`}` {}

// ─── synthetic Octokit deliveries (minimal wire shapes) ───────────

const issueOpened = (number: number) =>
  ({
    id: `delivery-opened-${number}`,
    name: "issues",
    payload: {
      action: "opened",
      issue: { number, title: `issue #${number}`, body: "body" },
      repository: { name: repo.repository, owner: { login: repo.owner } },
    },
  }) as unknown as GitHub.WebhookEvent;

const issueCommented = (number: number) =>
  ({
    id: `delivery-comment-${number}`,
    name: "issue_comment",
    payload: {
      action: "created",
      issue: { number },
      comment: { body: "any update?", user: { login: "reporter" } },
      repository: { name: repo.repository, owner: { login: repo.owner } },
    },
  }) as unknown as GitHub.WebhookEvent;

// an action no declared source matches (the catalog sources filter on
// action: opened / created) — must be denial-by-skip
const issueLabeled = (number: number) =>
  ({
    id: `delivery-labeled-${number}`,
    name: "issues",
    payload: {
      action: "labeled",
      issue: { number, title: `issue #${number}`, body: "body" },
      label: { name: "ready" },
      repository: { name: repo.repository, owner: { login: repo.owner } },
    },
  }) as unknown as GitHub.WebhookEvent;

// ─── the stubbed wire: capture the consume registration ──────────

interface ConsumeCall {
  readonly props: GitHub.RepositoryEventSourceProps;
  readonly handler: (
    event: GitHub.WebhookEvent,
  ) => Effect.Effect<void, never, RuntimeContext>;
}

const makeStubWire = () => {
  const calls: ConsumeCall[] = [];
  const layer = Layer.succeed(GitHub.RepositoryEventSource, ((
    props: ConsumeCall["props"],
    process: ConsumeCall["handler"],
  ) =>
    Effect.sync(() => {
      calls.push({ props, handler: process });
    })) as unknown as GitHub.RepositoryEventSourceService);
  return { calls, layer };
};

const scriptedModel = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: () => Effect.die(new Error("no model calls in routing")),
    streamText: () => Stream.fromIterable([]),
  }),
);

describe("GitHub.frontDoor — the derived front door", () => {
  it.effect(
    "adapts and routes by the virtual-actor rule: send, then steer, skip unmatched",
    () =>
      Effect.gen(function* () {
        const wire = makeStubWire();
        const sent: unknown[] = [];
        const steered: Array<{ key: string; item: unknown }> = [];
        // a recording ProcessService double: the front door resolves
        // the term's tag from context — the doors are what we assert
        const DeskDouble = Layer.succeed(Desk, {
          dispatch: () => Effect.die(new Error("front door never dispatches")),
          send: (item: unknown) => Effect.sync(() => void sent.push(item)),
          run: () => Effect.die(new Error("unused")),
          steer: (first: unknown, second?: unknown) =>
            Effect.sync(
              () => void steered.push({ key: String(first), item: second }),
            ),
          interrupt: () => Effect.void,
        } as never);

        // building the Layer runs the construction Effect: ONE consume
        // call for the repo, events = the union of both sources' bare
        // event names
        yield* Effect.scoped(
          Layer.build(
            GitHub.frontDoor(Desk).pipe(
              Layer.provide([DeskDouble, wire.layer]),
            ),
          ),
        );

        expect(wire.calls).toHaveLength(1);
        expect(wire.calls[0]!.props.owner).toBe(repo.owner);
        expect(wire.calls[0]!.props.repository).toBe(repo.repository);
        expect([...(wire.calls[0]!.props.events ?? [])].sort()).toEqual([
          "issue_comment",
          "issues",
        ]);

        const deliver = (event: GitHub.WebhookEvent) =>
          wire.calls[0]!.handler(event).pipe(
            Effect.provide(RuntimeContext.phantom),
          );

        // issues.opened #7 — first message for the case key: the send
        // door, payload adapted to the distilled IssueOpenedEvent shape
        yield* deliver(issueOpened(7));
        expect(sent).toEqual([
          {
            owner: repo.owner,
            repository: repo.repository,
            number: 7,
            title: "issue #7",
            body: "body",
          },
        ]);
        expect(steered).toEqual([]);

        // issue_comment.created #7 — the key is seen: the steer door,
        // addressed by the case key (the run's world identity)
        yield* deliver(issueCommented(7));
        expect(sent).toHaveLength(1);
        expect(steered).toEqual([
          {
            key: `${repo.owner}/${repo.repository}#7`,
            item: {
              owner: repo.owner,
              repository: repo.repository,
              number: 7,
              author: "reporter",
              comment: "any update?",
            },
          },
        ]);

        // issues.labeled — no declared source matches: nothing admitted
        yield* deliver(issueLabeled(7));
        expect(sent).toHaveLength(1);
        expect(steered).toHaveLength(1);

        // a different issue is a different actor: #8 takes the send door
        yield* deliver(issueOpened(8));
        expect(sent).toHaveLength(2);
      }),
  );

  it.effect(
    "the send door admits a real run on the memory kernel (run.admitted in the Trace)",
    () =>
      Effect.gen(function* () {
        const wire = makeStubWire();
        const first = yield* Deferred.make<unknown>();
        // the term's implementation is a deterministic handler — no
        // model in the delivery path (the scripted model dies if called)
        const DeskLive = AI.process(Desk, (item) =>
          Effect.as(Deferred.succeed(first, item), "answered"),
        );
        const kernelLayer = AI.memory.pipe(Layer.provide(scriptedModel));

        const { item, types } = yield* Effect.gen(function* () {
          const kernel = yield* AI.Kernel;
          // the front door registered its consume at Layer build
          expect(wire.calls).toHaveLength(1);
          yield* wire.calls[0]!.handler(issueOpened(7));
          const item = yield* Deferred.await(first);
          const trace = yield* Stream.runCollect(
            kernel
              .trace("FrontDoorDesk")
              .pipe(Stream.takeUntil((e) => e.type === "run.settled")),
          );
          return { item, types: [...trace].map((e) => e.type) };
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              GitHub.frontDoor(Desk).pipe(
                Layer.provide([
                  DeskLive.pipe(
                    Layer.provide([kernelLayer, RuntimeContext.phantom]),
                  ),
                  wire.layer,
                ]),
              ),
              kernelLayer,
              RuntimeContext.phantom,
            ),
          ),
        );

        // the handler received the ADAPTED work item, not the wire shape
        expect(item).toEqual({
          owner: repo.owner,
          repository: repo.repository,
          number: 7,
          title: "issue #7",
          body: "body",
        });
        // the admission is a durable fact: the run was created and ran
        // to its settled terminal
        expect(types[0]).toBe("run.admitted");
        expect(types).toContain("run.settled");
      }),
  );
});
