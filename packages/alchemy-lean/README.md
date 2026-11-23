# alchemy-lean

A domain model in [Lean 4](https://lean-lang.org): aggregates, decisions, views, policies, sagas and models as values, rules as theorems, and stories the compiler runs. A prototype, not a published package.

`examples/Bank` is the bank from `examples/cloudflare-domain`, block for block.

## The library

| File | What it holds |
|---|---|
| `Alchemy/Aggregate.lean` | `Aggregate` (`decide`, `evolve`, `reply`), a rule a command keeps (`Keeps`), a rule about one command (`Transition`), and `Invariant`, a rule with its proof |
| `Alchemy/Signature.lean` | What a model is made of: its aggregates, the calls it makes to outside systems, and its sagas |
| `Alchemy/Program.lean` | What a policy or a saga does, as data: send, call, wait for a signal, register a compensation, start or signal a saga, schedule. It is a monad, so a saga is a `do` block |
| `Alchemy/View.lean` | `View`, `Projection`, `Stream` and `Query`, each a function of the log, each with who may read it |
| `Alchemy/Model.lean` | `Decision`, `Policy`, `Model`, the `World`, and `Step`: everything a deployed model can do. `Model.invariant` and `Model.always` carry a rule to every world the model can reach |
| `Alchemy/Engine.lean` | An engine that runs a model in memory, with a proof that everything it does is a `Step` |
| `Alchemy/Story.lean` | Stories for one aggregate and for a model, checked by `decide` |
| `Alchemy/Check.lean` | A search for the shortest sequence of moves that breaks a rule |
| `Alchemy/Api.lean` | What one audience may send and read |
| `Alchemy/Host.lean` | Serves a model over HTTP and keeps it in a journal file |
| `Alchemy/Html.lean` | Pages as values: a page is a function of the model, and a form sends a command |

## Check it

```sh
curl https://elan.lean-lang.org/elan-init.sh -sSf | sh
lake build                           # proves every rule, runs every story and every search
lake exe bank bank.journal 8787      # serves http://127.0.0.1:8787, kept in bank.journal
```

## The server

`lake exe bank` serves the bank from `examples/Bank/Server.lean`. Everything that changes it is written to the journal before it is applied: each request that became a move, each answer an outside system gave, and each time the clock moved. The engine is a function, so replaying the journal at the start gives back the same world, with every saga where it stood.

- `POST /commands` sends a command: `{"as": "customer:c-1", "type": "DepositMoney", "accountId": "c-1-main", "amount": 100}`. It answers with what was recorded and the reply, or `409` with the rejection.
- `GET /accounts/:id/summary`, `/statement`, `/ledger?take=`, `/card`, `/customers/:id/dashboard` and `/transfers/:id` read as whoever `?as=` says, and answer `403` to a caller the view refuses.
- `GET /app?as=customer:c-1` is a customer's page and `/app?as=agent:support-7` an agent's (`examples/Bank/Web.lean`). Each page is a function of the bank and of who is looking, through the same guarded views; each form sends a command through the same Apis. A page stays live: it watches `/version` and loads again when anything is recorded.

The Apis decide what each caller may send. The clock follows the wall clock, so the daily limit and the approval window run in real time.

For each call the bank waits on, the server asks the service at `FRAUD_URL` or `PAYMENTS_URL` (with curl), and writes the answer to the journal, so a replay never asks again. With neither set, stand-ins answer.

## What `Step` covers

A caller sends a command. A decision records on several instances. An event reaches the policies in any order, or a second time. A policy or a saga takes its next step, whichever one is ready. An outside system answers a call with anything its type allows. Time passes. A scheduled command that is due fires.

A rule proved for every `Reachable` world holds whatever order those happen in.

## What is proved about the bank

- **Every instance, in every reachable world:** no account withdraws more than the daily limit, and every transfer is between two different accounts (`everyInstanceKeepsItsRules`).
- **Across instances, in every reachable world:** whoever a username is claimed for is registered under it, and the other way round, so no two customers hold one name (`namesAlwaysMatch`, `noTwoCustomersHoldOneName`).
- **About one command:** a closed account stays closed; money leaves only by a withdrawal or a transfer's debit; only an agent changes an owner; a frozen account pays nothing out; a transfer that ended stays as it ended; only an agent approves; expiry beats a late approval; a transfer that waits can always expire.
- **About the registration decision:** the name goes to who registered, only a free name is claimed, and a claimed name stays with its holder.
- **About the bank once it has settled:**
  - Every cent a transfer takes out of an account is paid into another, paid back, or recorded as stranded (`transfersLoseNoMoney` in `examples/Bank/Money.lean`). While a saga's run is part-way through, the difference is exactly what the runs still owe (`alwaysBalanced`). This holds for callers who send what the Apis offer.
  - Every transfer that was asked for has completed or failed, so none is left pending (`everyTransferEnds`, `noTransferLeftPending` in `examples/Bank/Pending.lean`). This holds whatever callers send.
  - Both proofs follow the ExecuteTransfer saga through each of its steps. "Settled" means every event is delivered and no policy or saga is part-way through or waiting. That the bank gets there, and does not stay busy for ever, is not proved.
- **About the ledger:** it has exactly one row for each money movement the accounts record, whatever the bank did (`ledgerIsGivenEveryMovement`).
- **Sometimes:** some reachable world has a customer with money, with the story as the witness (`anAccountCanHoldMoney`).
- **Stories:** twenty, the ones in `Bank.story.test.ts`, each run when the file compiles.

Each rule about an aggregate is two lines: a case split and `grind`.

## What is also checked by search

`Bank/Search.lean` runs every sequence of up to four of eight moves with compiled code (`native_decide`) and checks the settled-bank rules in each, the money rule again with events delivered twice, and that once the approval window closes every transfer has ended. A rule that is false gives the shortest sequence that breaks it.

## Run it in a container

```sh
docker build -t lean-bank .
docker run -p 8787:8787 -v bank:/data lean-bank
```

The journal is on the volume, so the bank survives the container. An alchemy stack can build and run the same Dockerfile, for example `Fly.Service("Bank", { context: "packages/alchemy-lean", port: 8787 })`; that stack is not written or deployed here, and it needs a volume at `/data` to keep the journal.

## Not built

- A cloud host of its own: the server is one process with one journal file. It runs in a container, not on Durable Objects or a cluster.
- A proof that the bank always settles: that every saga step and reaction eventually runs.
- A reader for existing TypeScript models.
