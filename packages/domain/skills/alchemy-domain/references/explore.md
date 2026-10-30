# Explore

`@alchemy.run/domain/Explore` runs the real model under every order of moves inside bounds, and checks rules after each step. A story checks one schedule you wrote. Explore looks for the order you did not write. It does not replace stories.

The loop: write rules → run → read the counterexample → make a RED Story → fix the model → run again.

```ts
import * as Explore from "@alchemy.run/domain/Explore";

const scenario: Explore.Scenario = {
  name: "holds",
  model: Holds,
  layer: Holds.layer(HoldExpiryLive), // needs only Platform: provide fakes here
  fakes: [],
  actors: [actor("place", new PlaceHold({ expiresAt }), (s) => s === undefined)],
  rules: [heldHasTimer],
  bounds: { depth: 12, budgets: { place: 1 } },
  startTimeMillis: start,
};

const report = await Explore.run(scenario); // bfs
const sample = await Explore.run(scenario, {
  search: { kind: "swarm", seeds: [1, 2, 3, 4], timeMillis: 60_000, depth: 22 },
});
```

More: [Explore a model](https://alchemy.run/domain/explore).

## Rules

| Kind         | Checked at                                               | Use for                                  |
| ------------ | -------------------------------------------------------- | ---------------------------------------- |
| `state`      | each state                                               | never true, even for one step            |
| `step`       | each step, with commits, calls and failures              | never happens                            |
| `quiescent`  | each state with no runnable work and no due timer        | true once the system settles             |
| `eventually` | a quiescent state where `when` holds, after a run-out    | `goal` within `horizonMillis`            |

- A `state` rule on a view or a timer fails on normal lag. Use `quiescent`.
- A rule must state a business fact, not an implementation detail. Read timers by command (`s.timers({ agg, id, command })`), not by id format.
- Give every rule `reachable` (a `state` or `step` trigger) and `source` (where the fact comes from).
- Derived rules run with no code: `DEFECT`, `DEAD-LETTER`, `TIMER-REARM`. Turn one off in `derived`.

More: [Explore a model: Choose a rule kind](https://alchemy.run/domain/explore#choose-a-rule-kind).

## VACUOUS

| Verdict     | Meaning                                                 |
| ----------- | ------------------------------------------------------- |
| `BROKEN`    | a counterexample exists                                 |
| `VACUOUS`   | the rule's trigger never fired: the rule was not tested |
| `HELD`      | no break, and the run closed its bounds                 |
| `NOT-FOUND` | no break in a cut-off or sampled run                    |

`VACUOUS` is a failure of the scenario. Add the actor or the budget that reaches the trigger. Never delete `reachable` to get a green run.

More: [Explore a model: Name the trigger](https://alchemy.run/domain/explore#name-the-trigger).

## Assumptions and fakes

A fake's state is plain JSON and lives in the search state. Implement the external system as a Layer over these helpers:

- `choose(label, options)`: a branch. The search runs every option. Option 0 is the default.
- `spend(name)`, `budgetLeft(name)`: a budget from `bounds.budgets`.
- `fakeState(name)`: the fake's state, mutable inside a move.
- `recordCall({ system, op, args, outcome })`: a `step` rule sees it.
- `now()`, `runningAs()`: the world clock, and who runs.

A fake is an assumption about a real system. Avoid both false results:

- A fake that never fails hides a failure path: `choose` the failures the real system has.
- A fake that does what the real system cannot gives a false break. Before you trust a break, check the fake against the real contract. Name the assumption in `rule.assumes`.

A layer holds no state outside `fakeState`, and a move has no async effect, `Clock.sleep`, `Math.random` or `crypto.randomUUID`. Each of these is an engine error.

More: [Explore a model: Write fakes as assumptions](https://alchemy.run/domain/explore#write-fakes-as-assumptions).

## Pools and bounds

Start small: 1 to 2 ids, each actor with a budget of 1. Add one dimension at a time, and watch `states`.

- `depth`: moves on one path. `actorSteps`: actor moves on one path.
- `redeliveries`: redeliver the last delivered item of a partition.
- `faults` with `host.faultable`: a send is lost, or its reply is lost.
- `ticks` with `clockSteps`: the clock moves with no fire. Without a tick, no actor acts at a deadline before its timer.
- `budgets`: your own one-shot actors and pools.

BFS for small bounds. Swarm for bounds BFS cannot close. A run with `CutOff` or `Sampled` coverage never says `HELD`.

More: [Explore a model: Set pools and bounds](https://alchemy.run/domain/explore#set-pools-and-bounds).

## Reading a counterexample

`report.violations[n]` has `rule`, `message`, `path`, `world` and `trace`. Read `path` from the end: find the move that made the rule false, then ask why the state before it let that move run. A step that looks impossible usually means a fake or an actor guard is wrong.

`Explore.toStory(scenario, violation, bindings)` runs the trace on the real Story runner, and needs a `storyTail` on the rule that throws `ruleFails(id)`. It gives code only when the Story fails on that rule. Anything else is `UnsupportedStoryTrace` with the reason. Save the code as a test: it stays red until the fix.

More: [Explore a model: Read a counterexample](https://alchemy.run/domain/explore#read-a-counterexample), [Explore a model: Turn a break into a Story](https://alchemy.run/domain/explore#turn-a-break-into-a-story).

## What a green run does not prove

`proof` is always `false`. A green run says nothing about:

- other actors, pools or depths;
- the real systems behind the fakes;
- crash points inside one atomic run, other than host faults on sends;
- a real platform's delivery order, retry timing or receipt retention;
- Api handlers, live reads, streams and sagas: a model with a stream or a saga is refused;
- anything a sample did not visit.

Keep stories for the behaviours you chose. Read `report.scope`, `report.abstractions`, `report.vacuous` and `report.complete` before you trust a green run.

More: [Explore a model: Know what a green run does not prove](https://alchemy.run/domain/explore#know-what-a-green-run-does-not-prove).
