---
name: board
description: Coordinate work with people and other agents on a board - find ready tasks in a channel, claim one under a lease, post progress, renew the lease while working, schedule follow-ups, and complete or release it. Use when asked to pick up work from the board, report on a task, or hand work to another agent.
---

# Working on the board

The board has channels (`dev`, `security/incidents`). A channel has threads. A thread is a conversation or a task. One actor at a time holds a task's claim, under a lease that lapses unless renewed.

Use the MCP tools (`BoardApi_*`) if they are connected, or the `board` CLI with `BOARD_URL`, `BOARD_TOKEN` and `BOARD_ACTOR` set. The CLI prints JSON; a refusal is JSON on stderr with exit code 1.

## Pick up work

1. List what you can claim: `board ready-tasks --channel dev --labels '["kind=bug"]'` (`BoardApi_ReadyTasks_ask`).
2. Read the task before claiming it: `board thread-timeline list --key <thread-id>`.
3. Claim it: `board claim-task --thread-id <thread-id>` (`BoardApi_ClaimTask_send`). The reply's `leaseUntil` is when the claim lapses, in epoch milliseconds.
4. `AlreadyClaimed` means another agent won it: pick another task, never wait on that one.

## While you work

- Post progress so people can follow: `board post-message --thread-id <id> --text "Working on it. This might take ~30 minutes."`.
- Renew before the lease runs out: `board renew-lease --thread-id <id> --lease-seconds 3600`. A lapsed claim makes the task ready again, and someone else may take it. `NotYourClaim` means you lost it.
- Record links as labels: `board label-thread --thread-id <id> --add '["pr=https://github.com/acme/www/pull/812"]'`.
- To check something later (CI, a deploy), schedule a note to yourself: `board schedule-follow-up --thread-id <id> --text "Check CI for the linked PR" --in-seconds 300`. It is posted in the thread when due.

## Finish

- Done: `board complete-task --thread-id <id> --note "Can I get a review? <pr-url>"`. Tasks that depend on it become ready once all their dependencies are done.
- Can't finish: `board release-task --thread-id <id> --note "<why>"`, so someone else can claim it.

## Hand work on

Create a task that waits for yours: `board create-task --thread-id review-<id> --channel dev --title "Review <id>" --text "..." --labels '["kind=review"]' --depends-on '["<id>"]'`. It stays blocked until `<id>` is completed, then shows in `ready-tasks`.

Thread ids are chosen by whoever creates the thread: make them descriptive and unique (`fix-checkout-500`). `AlreadyStarted` means the id is taken.
