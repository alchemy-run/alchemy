------------------------------ MODULE TwoPhase ------------------------------
(***************************************************************************)
(* How a decision commits across instances that each keep their own        *)
(* storage: the protocol of `src/TwoPhase.ts`, from the moment the primary *)
(* holds the plan (`Primary.hold` answered `Held`) to the moment nothing   *)
(* of the attempt is left anywhere.                                        *)
(*                                                                         *)
(* One attempt is modelled. Each action is one call the code makes, and    *)
(* says which function it stands for. What the model adds to the code is   *)
(* everything that can go wrong around it: a call that does not arrive, a  *)
(* driver that dies, a wake-up that overlaps the call it is finishing,     *)
(* another command that changes an instance, another decision that holds   *)
(* one.                                                                    *)
(*                                                                         *)
(* Checked by packages/integration-tests/test/Domain/TwoPhase.spec.test.ts *)
(* with two other instances, two runs and two failures. The same test runs *)
(* the real `finish` and `deliver`, and checks the steps they take against *)
(* this model.                                                             *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Others,            \* the instances the primary prepares: `plan.others`
  Writers,           \* the ones with events to record; the rest were only read
  Drivers,           \* runs of `finish`
  Caller,            \* the run in the call that held the plan; the others are wake-ups
  MaxFaults,         \* how many times something goes wrong
  RecordsOutcome,    \* TRUE in the code. FALSE: the primary keeps no outcome for the others
  AbortChecksCommit  \* TRUE in the code. FALSE: `Primary.abort` forgets it may have committed

VARIABLES
  pIntent,   \* the primary holds the plan: its `intent`
  pRec,      \* the outcome it keeps for the others: `tx:<txId>`
  waiting,   \* who has not received that outcome
  pApplied,  \* the primary recorded its events: the attempt committed
  pAborted,  \* the primary gave the attempt up
  oIntent,   \* an instance holds its part of the attempt
  oApplied,  \* an instance recorded its part
  oVersion,  \* 0 while an instance is as it was read
  oHeld,     \* another decision's intent holds the instance
  pc,        \* where each run of `finish` is
  todo,      \* the instances a run has still to prepare, or to tell
  reached,   \* the instances a run's `deliver` reached
  outcome,   \* what a run is delivering
  faults     \* how many times something went wrong so far

vars == <<pIntent, pRec, waiting, pApplied, pAborted, oIntent, oApplied, oVersion,
          oHeld, pc, todo, reached, outcome, faults>>

primary == <<pIntent, pRec, waiting, pApplied, pAborted>>
others  == <<oIntent, oApplied, oVersion, oHeld>>

Init ==
  /\ pIntent = TRUE
  /\ pRec = "none"
  /\ waiting = {}
  /\ pApplied = FALSE
  /\ pAborted = FALSE
  /\ oIntent = [o \in Others |-> FALSE]
  /\ oApplied = [o \in Others |-> FALSE]
  /\ oVersion = [o \in Others |-> 0]
  /\ oHeld = [o \in Others |-> FALSE]
  /\ pc = [d \in Drivers |-> IF d = Caller THEN "prepare" ELSE "idle"]
  /\ todo = [d \in Drivers |-> Others]
  /\ reached = [d \in Drivers |-> {}]
  /\ outcome = [d \in Drivers |-> "Aborted"]
  /\ faults = 0

Rest(d) == IF d = Caller THEN "done" ELSE "idle"

Telling(d, what) ==
  /\ pc' = [pc EXCEPT ![d] = "deliver"]
  /\ outcome' = [outcome EXCEPT ![d] = what]
  /\ todo' = [todo EXCEPT ![d] = Others]
  /\ reached' = [reached EXCEPT ![d] = {}]

\* An instance turns its intent into events: `applyIntent` on a participant.
Apply(o) ==
  /\ oIntent' = [oIntent EXCEPT ![o] = FALSE]
  /\ oApplied' = [oApplied EXCEPT ![o] = TRUE]
  /\ oVersion' = [oVersion EXCEPT ![o] = IF o \in Writers THEN 1 ELSE @]

\* `Participant.prepare`, in `finish`.
Prepare(d, o) ==
  /\ pc[d] = "prepare"
  /\ o \in todo[d]
  /\ UNCHANGED <<primary, oApplied, oVersion, oHeld, reached, outcome, faults>>
  /\ IF oIntent[o] \/ (~oHeld[o] /\ oVersion[o] = 0)
       THEN /\ oIntent' = [oIntent EXCEPT ![o] = TRUE]
            /\ todo' = [todo EXCEPT ![d] = @ \ {o}]
            /\ pc' = [pc EXCEPT ![d] = IF todo[d] = {o} THEN "commit" ELSE "prepare"]
       ELSE \* `Busy` or `Conflict`
            /\ pc' = [pc EXCEPT ![d] = "undo"]
            /\ UNCHANGED <<oIntent, todo>>

\* `Participant.prepare` fails with `Unreachable`.
PrepareFails(d, o) ==
  /\ pc[d] = "prepare"
  /\ o \in todo[d]
  /\ faults < MaxFaults
  /\ faults' = faults + 1
  /\ pc' = [pc EXCEPT ![d] = "undo"]
  /\ UNCHANGED <<primary, others, todo, reached, outcome>>

\* `Primary.commit`, in `finish`: the commit point.
PrimaryCommit(d) ==
  /\ pc[d] = "commit"
  /\ UNCHANGED <<pAborted, others, faults>>
  /\ IF pIntent
       THEN /\ pIntent' = FALSE
            /\ pApplied' = TRUE
            /\ pRec' = IF RecordsOutcome THEN "Committed" ELSE pRec
            /\ waiting' = IF RecordsOutcome THEN Others ELSE waiting
            /\ Telling(d, "Committed")
       ELSE /\ UNCHANGED <<pIntent, pApplied, pRec, waiting>>
            /\ IF pRec = "Committed"
                 THEN Telling(d, "Committed")
                 ELSE \* `Gone`
                      /\ pc' = [pc EXCEPT ![d] = "undo"]
                      /\ UNCHANGED <<todo, reached, outcome>>

\* `Primary.abort`, in `undo`.
PrimaryAbort(d) ==
  /\ pc[d] = "undo"
  /\ UNCHANGED <<pApplied, others, faults>>
  /\ IF pIntent
       THEN /\ pIntent' = FALSE
            /\ pAborted' = TRUE
            /\ pRec' = IF RecordsOutcome THEN "Aborted" ELSE pRec
            /\ waiting' = IF RecordsOutcome THEN Others ELSE waiting
            /\ Telling(d, "Aborted")
       ELSE /\ UNCHANGED <<pIntent, pAborted, pRec, waiting>>
            /\ Telling(d, IF AbortChecksCommit /\ pRec # "none" THEN pRec ELSE "Aborted")

\* `Participant.commit` or `Participant.abort`, in `deliver`.
Deliver(d, o) ==
  /\ pc[d] = "deliver"
  /\ o \in todo[d]
  /\ todo' = [todo EXCEPT ![d] = @ \ {o}]
  /\ reached' = [reached EXCEPT ![d] = @ \cup {o}]
  /\ UNCHANGED <<primary, oHeld, pc, outcome, faults>>
  /\ IF ~oIntent[o]
       THEN UNCHANGED <<oIntent, oApplied, oVersion>>
       ELSE IF outcome[d] = "Committed"
              THEN Apply(o)
              ELSE /\ oIntent' = [oIntent EXCEPT ![o] = FALSE]
                   /\ UNCHANGED <<oApplied, oVersion>>

\* The same call fails with `Unreachable`: the instance is not noted as reached.
DeliverFails(d, o) ==
  /\ pc[d] = "deliver"
  /\ o \in todo[d]
  /\ faults < MaxFaults
  /\ faults' = faults + 1
  /\ todo' = [todo EXCEPT ![d] = @ \ {o}]
  /\ UNCHANGED <<primary, others, pc, reached, outcome>>

\* `Primary.delivered`, at the end of `deliver`.
Delivered(d) ==
  /\ pc[d] = "deliver"
  /\ todo[d] = {}
  /\ pc' = [pc EXCEPT ![d] = Rest(d)]
  /\ UNCHANGED <<pIntent, pApplied, pAborted, others, todo, reached, outcome, faults>>
  /\ IF pRec = "none"
       THEN UNCHANGED <<pRec, waiting>>
       ELSE /\ waiting' = waiting \ reached[d]
            /\ pRec' = IF waiting \subseteq reached[d] THEN "none" ELSE pRec

\* The primary's wake-up: `finish` from the plan in storage, or `deliver` of
\* an outcome somebody has not received.
Wake(d) ==
  /\ d # Caller
  /\ pc[d] = "idle"
  /\ UNCHANGED <<primary, others, faults>>
  /\ IF pIntent
       THEN /\ pc' = [pc EXCEPT ![d] = "prepare"]
            /\ todo' = [todo EXCEPT ![d] = Others]
            /\ UNCHANGED <<reached, outcome>>
       ELSE /\ pRec # "none"
            /\ pc' = [pc EXCEPT ![d] = "deliver"]
            /\ outcome' = [outcome EXCEPT ![d] = pRec]
            /\ todo' = [todo EXCEPT ![d] = waiting]
            /\ reached' = [reached EXCEPT ![d] = {}]

\* A run dies where it is: the object was evicted, or the sender hung up.
Dies(d) ==
  /\ pc[d] \in {"prepare", "commit", "undo", "deliver"}
  /\ faults < MaxFaults
  /\ faults' = faults + 1
  /\ pc' = [pc EXCEPT ![d] = IF d = Caller THEN "dead" ELSE "idle"]
  /\ UNCHANGED <<primary, others, todo, reached, outcome>>

\* An instance that holds an intent asks the primary what became of it:
\* `txOutcome`, from `settle`. `Pending` changes nothing, so it is not a step.
Ask(o) ==
  /\ oIntent[o]
  /\ ~pIntent
  /\ UNCHANGED <<primary, oHeld, pc, todo, reached, outcome, faults>>
  /\ IF pRec = "Committed"
       THEN Apply(o)
       ELSE /\ oIntent' = [oIntent EXCEPT ![o] = FALSE]
            /\ UNCHANGED <<oApplied, oVersion>>

\* Another command changes an instance nothing holds.
Changes(o) ==
  /\ ~oIntent[o] /\ ~oHeld[o] /\ oVersion[o] = 0
  /\ faults < MaxFaults
  /\ faults' = faults + 1
  /\ oVersion' = [oVersion EXCEPT ![o] = 1]
  /\ UNCHANGED <<primary, oIntent, oApplied, oHeld, pc, todo, reached, outcome>>

\* Another decision holds an instance, and lets it go.
Holds(o) ==
  /\ ~oIntent[o] /\ ~oHeld[o]
  /\ faults < MaxFaults
  /\ faults' = faults + 1
  /\ oHeld' = [oHeld EXCEPT ![o] = TRUE]
  /\ UNCHANGED <<primary, oIntent, oApplied, oVersion, pc, todo, reached, outcome>>

LetsGo(o) ==
  /\ oHeld[o]
  /\ oHeld' = [oHeld EXCEPT ![o] = FALSE]
  /\ UNCHANGED <<primary, oIntent, oApplied, oVersion, pc, todo, reached, outcome, faults>>

Works ==
  \/ \E d \in Drivers : PrimaryCommit(d) \/ PrimaryAbort(d) \/ Delivered(d) \/ Wake(d)
  \/ \E d \in Drivers, o \in Others : Prepare(d, o) \/ Deliver(d, o)
  \/ \E o \in Others : Ask(o) \/ LetsGo(o)

GoesWrong ==
  \/ \E d \in Drivers : Dies(d)
  \/ \E d \in Drivers, o \in Others : PrepareFails(d, o) \/ DeliverFails(d, o)
  \/ \E o \in Others : Changes(o) \/ Holds(o)

Next == Works \/ GoesWrong

Spec == Init /\ [][Next]_vars /\ WF_vars(Works)

-----------------------------------------------------------------------------

TypeOK ==
  /\ pIntent \in BOOLEAN /\ pApplied \in BOOLEAN /\ pAborted \in BOOLEAN
  /\ pRec \in {"none", "Committed", "Aborted"}
  /\ waiting \subseteq Others
  /\ oIntent \in [Others -> BOOLEAN] /\ oApplied \in [Others -> BOOLEAN]
  /\ oVersion \in [Others -> 0..1] /\ oHeld \in [Others -> BOOLEAN]
  /\ pc \in [Drivers -> {"idle", "prepare", "commit", "undo", "deliver", "done", "dead"}]
  /\ todo \in [Drivers -> SUBSET Others] /\ reached \in [Drivers -> SUBSET Others]
  /\ outcome \in [Drivers -> {"Committed", "Aborted"}]
  /\ faults \in 0..MaxFaults

\* No instance records its part of an attempt the primary did not commit.
Atomic == \A o \in Others : oApplied[o] => pApplied

\* The outcome changes once.
OneOutcome == ~(pApplied /\ pAborted)

\* Once the attempt committed, every instance has recorded its part or still holds it.
NothingLost == pApplied => \A o \in Others : oApplied[o] \/ oIntent[o]

\* A run tells the others an attempt aborted when it committed only once the
\* primary has forgotten it: every instance has the outcome by then, so the
\* word reaches no intent of that attempt that still has events to record.
LateAbortIsHarmless ==
  \A d \in Drivers :
    (pc[d] = "deliver" /\ outcome[d] = "Aborted" /\ pApplied) => pRec = "none"

\* In the end nothing of the attempt is left anywhere, and all of it happened or none.
Settles ==
  <>[](/\ ~pIntent
       /\ pRec = "none"
       /\ \A o \in Others : ~oIntent[o]
       /\ \A o \in Others : oApplied[o] = pApplied)

=============================================================================
