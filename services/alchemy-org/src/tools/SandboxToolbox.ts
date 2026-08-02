/**
 * The SANDBOX toolbox — the Worker-side half of the org's keyboard on
 * Cloudflare: the same tool tags, the same access-level groups as
 * `LocalToolbox.ts`, with each callable forwarding to the sandbox
 * container (services/Sandbox.ts) where the identical local physics
 * run. The run key crosses the wire so `Git.Workspaces` lands the
 * call in the run's own worktree — the same join, one RPC hop later.
 *
 * - Coding           = Read + Run + Write (the full keyboard)
 * - QualityAssurance = Read + Run        (verify, never author)
 */
import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Ledger } from "../services/Ledger.ts";
import { renderError } from "../lib/RenderError.ts";
import { prLinkKey, testAlchemy } from "../Repos.ts";
import SandboxHost from "../services/SandboxHost.ts";
import {
  ApplyPatch,
  Bash,
  EditFile,
  Glob,
  Grep,
  ListDirectory,
  OpenPullRequest,
  ReadFile,
  ReadOutput,
  WriteFile,
} from "./index.ts";

/** One tool tag → a Layer whose callable forwards to the sandbox. */
const forward = (tag: { readonly "~alchemy/Name": string }) =>
  Layer.effect(
    tag as never,
    Effect.gen(function* () {
      const hosts = yield* SandboxHost;
      const tool = tag["~alchemy/Name"];
      return ((params: unknown) =>
        Effect.gen(function* () {
          const { key } = yield* AI.Thread;
          // getByName is LAZY: at plan the namespace is a stub — only
          // runtime calls may address an instance
          return yield* hosts
            .getByName("org")
            .call({ tool, key, params })
            .pipe(Effect.mapError(renderError));
        })) as never;
    }),
  ) as Layer.Layer<never>;

/** Search and read: the eyes. */
export const ReadToolsSandbox = Layer.mergeAll(
  forward(Grep),
  forward(Glob),
  forward(ListDirectory),
  forward(ReadFile),
) as Layer.Layer<Grep | Glob | ListDirectory | ReadFile, never, never>;

/** Execute and page output: the hands on the REPL. */
export const RunToolsSandbox = Layer.mergeAll(
  forward(Bash),
  forward(ReadOutput),
) as Layer.Layer<Bash | ReadOutput, never, never>;

/** Structured mutation: the pen. */
export const WriteToolsSandbox = Layer.mergeAll(
  forward(EditFile),
  forward(ApplyPatch),
  forward(WriteFile),
) as Layer.Layer<EditFile | ApplyPatch | WriteFile, never, never>;

/**
 * OpenPullRequest, sandbox flavor — the SAME two halves as the local
 * physics, split across the wire at the natural seam: the container
 * does the git dance (`push`), the Worker does the GitHub API call
 * and records the PR→issue link in the Ledger.
 */
export const OpenPullRequestSandbox = Layer.effect(
  OpenPullRequest,
  Effect.gen(function* () {
    const hosts = yield* SandboxHost;
    const createPullRequest = yield* GitHub.CreatePullRequest(testAlchemy);
    const ledger = yield* Ledger;

    return ((input: {
      issue?: { owner: string; repository: string; number: number };
      title: string;
      body: string;
    }) =>
      Effect.gen(function* () {
        const { key } = yield* AI.Thread;
        const branch =
          input.issue !== undefined
            ? `factory/issue-${input.issue.number}`
            : `factory/${key.replaceAll(/[^a-zA-Z0-9._-]+/g, "-")}`;
        yield* hosts
          .getByName("org")
          .push({
            key,
            branch,
            message:
              input.issue !== undefined
                ? `${input.title} (#${input.issue.number})`
                : input.title,
          })
          .pipe(Effect.mapError(renderError));

        const pull = yield* createPullRequest({
          title: input.title,
          body: input.body,
          head: branch,
          base: "main",
        }).pipe(
          Effect.mapError(
            (error) =>
              `${error.operation} failed: ${error.message} — if a PR for ` +
              `${branch} already exists, the push above updated it; cite that one`,
          ),
        );

        if (input.issue !== undefined) {
          yield* ledger.put(
            prLinkKey(
              `${input.issue.owner}/${input.issue.repository}`,
              pull.number,
            ),
            input.issue.number,
          );
        }

        const identity = yield* GitHub.resolveRepository(testAlchemy);
        return {
          opened: pull.html_url,
          pr: {
            owner: identity.owner,
            repository: identity.repository,
            number: pull.number,
            url: pull.html_url,
          },
        };
      })) as never;
  }),
);
