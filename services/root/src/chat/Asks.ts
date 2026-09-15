import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * The ASK TREE — the company's conversation, as structure.
 *
 * Every ask is a NODE: who asked whom, the question, the answer, and
 * the PARENT ask it was made under (the target asked someone else
 * while answering). A chain of asks is a path; a conversation is a
 * tree — and the UI renders any node's subtree the way reddit renders
 * a thread:
 *
 * ```
 * head asks manager: can we ship #1521?
 * ├─ manager asks e-4f2a: is the D1 flake understood?
 * │  └─ e-4f2a answers: yes — a fencepost in the retry; fix pushed
 * └─ manager answers: yes, pending the merge proposal
 * ```
 *
 * The store is write-through from the Ask tool's physics (open when
 * the question dispatches, settle when the answer bubbles back), so
 * the tree is live while chains run — a running node is a question
 * still being answered somewhere down the lineage.
 */

export interface AskNode {
  readonly id: string;
  /** The ask this one was made UNDER — absent for a root ask. */
  readonly parent?: string;
  /** The call whose thread holds this exchange, when on one. */
  readonly call?: string;
  readonly asker: string;
  readonly target: string;
  /** The asker's ONE-LINE label — what the live tree shows. */
  readonly title?: string;
  readonly question: string;
  readonly answer?: string;
  readonly status: "running" | "answered" | "failed";
  readonly at: number;
  /** The asks the target made while answering — nested, oldest first. */
  readonly children: ReadonlyArray<AskNode>;
}

export class Asks extends Context.Service<
  Asks,
  {
    readonly open: (input: {
      readonly id: string;
      readonly parent?: string;
      readonly call?: string;
      readonly asker: string;
      readonly target: string;
      readonly title?: string;
      readonly question: string;
    }) => Effect.Effect<void>;
    readonly settle: (
      id: string,
      status: "answered" | "failed",
      answer: string,
    ) => Effect.Effect<void>;
    readonly tree: (id: string) => Effect.Effect<AskNode | undefined>;
    readonly roots: (limit?: number) => Effect.Effect<ReadonlyArray<AskNode>>;
  }
>()("Asks") {}
