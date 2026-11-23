# alchemy-bend

A domain model in [Bend 2](https://github.com/bendlang/bend): aggregates as pure functions, rules as laws, and proofs the compiler checks. A prototype, not a published package.

`examples/bank` is the bank from `examples/cloudflare-domain`. Money is whole cents and time is whole seconds, as there. Ids are numbers.

| File | What it holds |
|---|---|
| `Domain.bend` | What every aggregate shares: `Decided`, `Sent`, and the templates `apply`, `settle`, `step` and `replay` |
| `Model.bend` | An engine for any model: the world, and the templates `send`, `step`, `play`, `run` and `steps`, which take a model's `emit`, `react`, `advance` and `answer` |
| `examples/bank/Account.bend` | The account: ten commands, `decide`, `evolve` |
| `examples/bank/Transfer.bend` | The transfer, with approval and expiry |
| `examples/bank/Customer.bend` | The customer, the username claim, the registration decision across both, and the registry |
| `examples/bank/Bank.bend` | The bank, given to the engine: its commands, events and saga steps, what a command records, the five policies, the ExecuteTransfer saga one step at a time with its compensation, and the answers from outside systems |
| `examples/bank/Views.bend` | The reads: summary, statement, ledger, activity, account card, dashboard, transfer status, transfers by account, each with who may read it |
| `examples/bank/Api.bend` | What customers and support agents may send |
| `examples/bank/Stories.bend` | The worlds the stories end in, each a sequence of moves |
| `examples/bank/LAWS.bend` | 59 laws: the rules, and what each story leaves |
| `examples/bank/PROOF.bend` | Their proofs |
| `examples/bank/Search.bend` | A search for the shortest sequence of moves that breaks a rule |
| `examples/bank/Server.bend` | The bank over HTTP, kept in a journal file, with pages that are functions of the bank, and a wall clock of its own (`clock.c`, `clock.js`) |
| `examples/bank/durable-object/` | The proved bank on a Cloudflare Durable Object, its journal in the object's storage |
| `examples/bank/host.mjs` | The proved bank driven from JavaScript |

## Check it

```sh
curl -fsSL https://bend-lang.com/install.sh | sh
cd examples/bank
bend PROOF.bend                # ALL PROOFS CHECK
bend PROOF.bend --verdict      # the same, rechecked by the kernel that has a proof in Lean (needs Lean 4.34.0)
bend Search.bend               # the rules about a settled bank, and two rules that are false
bend Server.bend               # serves http://127.0.0.1:8788, kept in ./bank.journal
bend Server.bend -o build/bank  # a native binary; -o build/bank.js for one that bun runs
bend Bank.bend -o build/Bank.mjs && node host.mjs
```

## What a step is

`Bank.step` is one thing that can happen: a caller sends a command, an undelivered event reaches the policies (whichever one), an event already delivered reaches them again, the saga takes its next step (whichever one is ready), an outside system answers, time passes. `Bank.play` is a step and then everything that follows from it.

## What is proved

For any sequence of steps:

- every account is within its daily limit;
- every transfer is between two different accounts;
- a customer is registered under a name exactly when that name is claimed for them, so no two customers hold one name.

About one command or one decision:

- a closed account stays closed, a frozen account refuses a withdrawal, and only an agent changes an owner;
- a transfer that ended stays as it ended, and one that waits for approval can always expire;
- a claimed username stays with its holder, a registered customer is not registered again, and the name goes to who registered.

And:

- some sequence of moves leaves a customer with money, with the sequence as the witness;
- each of the 22 stories, a law with no parameters proved by running it. Two of them step the saga by hand: the destination closes between the debit and the credit, and a request is delivered three times.

## What is checked, not proved

`Search.bend` checks these in every sequence of up to four of nine moves, one of them a redelivery, once the bank has settled: no transfer loses money, none is left pending, and every one has ended once the approval window closes. A rule that is false gives the shortest sequence that breaks it. `@alchemy.run/domain` checks the same rules the same way.

## The server

`bend Server.bend` serves the bank and writes each request that changes it to `bank.journal` before applying it. At the start it replays the journal, so the bank is where it was, with every saga where it stood. The clock follows the wall clock, and each move of it is in the journal too.

A request's path says who asks and what for: `/c/1/account/101/deposit/5000`, `/a/7/transfer/1/approve`, `/c/1/account/101/summary`. The Apis decide what each caller may send, and each read is guarded. `/app/c/1` is customer 1's page and `/app/a/7` an agent's: each is a function of the bank and of who is looking, and each link on it sends a command. A page stays live: it watches `/version` and loads again when anything is recorded.

```sh
docker build -t bend-bank . && docker run -p 8788:8788 -v bank:/data bend-bank
```

### Outside systems

For each call the bank waits on, the server asks the service at `FRAUD_URL` or `PAYMENTS_URL` (with curl), and writes the answer to the journal as a line of its own, so a replay never asks again. With neither set, stand-ins answer.

### On a Durable Object

Bend compiles the bank's pure functions to a JavaScript module, and `durable-object/worker.mjs` hosts them: one object is one writer, its journal is the object's storage, and it replays the journal when it wakes. It calls the outside systems with `fetch`.

```sh
bend Server.bend -o durable-object/Server.mjs
cd durable-object && npx wrangler dev --local
```

This has run locally under workerd, across a restart. It has not been deployed.

## How it differs from the TypeScript and Lean models

- **The engine is generic, by templates.** `Model.bend` takes a model's four functions at compile time. A Bend closure is used at most once and there are no type classes, so a policy or a saga is still a function of the world, not a value in a list.
- **State is the commands replayed.** The world keeps every command that was sent. That is what makes a rule about one aggregate a rule about every instance.
- **Ids are numbers,** not strings.
- **Sums wrap.** Money and time are 32-bit, so a sum past 4,294,967,295 wraps. Bend's unbounded numbers are unary, and the proven kernel cannot run stories with six-digit amounts on them.
- **Outside calls are answered in order.**
- **Nothing here has been deployed.** The server runs as a process, in a container, and on a local Durable Object.
