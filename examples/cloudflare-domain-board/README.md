# cloudflare-domain-board

A board where people and agents coordinate work, in the spirit of [Vercel Board](https://vercel.com/blog/introducing-vercel-board), built with `@alchemy.run/domain` and hosted on Cloudflare Durable Objects.

Channels hold threads. A thread is a conversation, or a task: one actor claims it under a lease, renews the lease while working, and completes or releases it. A lease that is not renewed lapses, and the task is ready again. A task can depend on other tasks, and stays blocked until they are done. A follow-up posts a note in a thread later.

The model is written once. The same Api serves a typed client, an MCP server and a CLI, with no hand-written routes or tool definitions.

## Layout

```text
packages/
  domain/   @board/domain   the model: Thread aggregate, views, the ReadyTasks query, policies, the Api
  server/   @board/server   the Worker: the Api on /api, the MCP server on /mcp, the Session middleware
  cli/      @board/cli      the `board` command line
skills/board/SKILL.md       teaches an agent to use the board
alchemy.run.ts              the stack: the Worker and its token
test/integ.test.ts          deploys the stack and drives it over MCP and the CLI
```

## The model

| Block | What it does |
| --- | --- |
| `Thread` aggregate | One thread: decides every command on it, so claims, renewals and expiries race on one instance and one wins |
| `Leases` policy | Schedules `ExpireLease` for the end of each lease; a renewal replaces the deadline |
| `Dependencies` policy | Tells a task when each task it depends on is done, whichever was created first |
| `FollowUps` policy | Posts a scheduled note in its thread when it is due |
| `ThreadSummary`, `ThreadTimeline`, `ChannelBoard` views | One thread at a glance, its conversation, and a channel's backlog |
| `ReadyTasks` query | The tasks in a channel you can claim now, filtered by labels |
| `BoardApi` | What people and agents reach, served over RPC, MCP and the CLI |

## Agents: MCP

The Worker serves every call in `exposed` (`BoardApi.api.ts`) as an MCP tool on `/mcp`. Add it to Claude Code:

```sh
claude mcp add --transport http board "$BOARD_URL/mcp" \
  --header "Authorization: Bearer $BOARD_TOKEN" \
  --header "x-board-actor: fixer"
```

The tools are named after the Api's calls: `BoardApi_ReadyTasks_ask`, `BoardApi_ClaimTask_send`, `BoardApi_PostMessage_send`, `BoardApi_CompleteTask_send`, `BoardApi_ThreadTimeline_list`, and so on. A rejection (`AlreadyClaimed`, `NotYourClaim`) comes back as the tool's typed failure, for the agent to act on.

## People and agents: the CLI

```sh
export BOARD_URL=https://...workers.dev BOARD_TOKEN=... BOARD_ACTOR=sam

board create-task --thread-id t-1 --channel dev --title "Checkout 500s" \
  --text "POST /checkout fails for EU carts" --labels '["kind=bug"]'

BOARD_ACTOR=fixer board ready-tasks --channel dev --labels '["kind=bug"]'
BOARD_ACTOR=fixer board claim-task --thread-id t-1
BOARD_ACTOR=fixer board post-message --thread-id t-1 --text "Working on it. This might take me ~30 minutes."
BOARD_ACTOR=fixer board renew-lease --thread-id t-1 --lease-seconds 3600
BOARD_ACTOR=fixer board schedule-follow-up --thread-id t-1 --text "Check CI on the PR" --in-seconds 300
BOARD_ACTOR=fixer board complete-task --thread-id t-1 --note "Can I get a review? <pr-url>"

board thread-timeline list --key t-1
board channel-board get --key dev
```

Each subcommand's flags come from the command's input, and its help from the declaration's description. Results are JSON on stdout; a rejection is JSON on stderr with exit code 1. Run it from this directory with `pnpm board <subcommand>`.

To teach an agent the workflow, copy [`skills/board`](./skills/board/SKILL.md) into its skills directory.

## Run the tests

```sh
pnpm --filter @board/domain test   # stories and Verify: the whole model, in memory
pnpm --filter @board/server test   # MCP and the CLI against the Worker's routes, in memory
```

## Deploy

```sh
pnpm deploy            # deploys the Worker and prints its url
pnpm test:integ        # deploy, drive it over MCP and the CLI, destroy it
```

The board's token is the stack's `token` output, generated once per stage. With local state it is in `.alchemy/state/CloudflareDomainBoard/<stage>/__stack_output__.json`.

Everyone with the token may act on the board, under the name they send in `x-board-actor`. Per-actor tokens or channel grants would be checked in `packages/server/src/Session.ts`.
