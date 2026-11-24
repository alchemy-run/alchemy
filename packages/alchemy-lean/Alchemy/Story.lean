import Alchemy.Engine

/-!
A story: an example of what a model does, checked when the file compiles.
Every outcome has to be accounted for: each event recorded, each rejection, and
each call to an outside system must be asserted before the story ends.
-/
namespace Alchemy

/-! ## One aggregate -/

inductive Story.Step (a : Aggregate) where
  /-- History: events already recorded. -/
  | given (events : List a.Event)
  /-- The commands that follow are sent by this actor. -/
  | as (actor : a.Actor)
  /-- The commands that follow are sent at this time. -/
  | clock (time : Time)
  /-- Send a command. -/
  | when (command : a.Command)
  /-- The last command recorded exactly these events. -/
  | recorded (events : List a.Event)
  /-- The last command was rejected with this. -/
  | rejected (rejection : a.Rejection)
  /-- The state is this. -/
  | state (state : a.State)

namespace Story

variable {a : Aggregate}

/-- Runs the steps. `pending` is the last command's answer, until a step asserts it. -/
def run (ctx : Context a.Actor) (s : a.State)
    (pending : Option (Except a.Rejection (List a.Event))) : List (Step a) → Bool
  | [] => pending.isNone
  | .given es :: rest => pending.isNone && run ctx (a.apply s es ctx.now) none rest
  | .as actor :: rest => run { ctx with actor } s pending rest
  | .clock time :: rest => run { ctx with now := time } s pending rest
  | .when c :: rest =>
    pending.isNone &&
      match a.decide ctx s c with
      | .ok es => run ctx (a.apply s es ctx.now) (some (.ok es)) rest
      | .error r => run ctx s (some (.error r)) rest
  | .recorded es :: rest =>
    match pending with
    | some (.ok actual) => decide (actual = es) && run ctx s none rest
    | _ => false
  | .rejected r :: rest =>
    match pending with
    | some (.error actual) => decide (actual = r) && run ctx s none rest
    | _ => false
  | .state expected :: rest => decide (s = expected) && run ctx s pending rest

end Story

/-- A story passes when every step holds and no outcome is left unasserted. -/
def Aggregate.story (a : Aggregate) (actor : a.Actor) (steps : List (Story.Step a)) : Bool :=
  Story.run ⟨actor, 0⟩ a.initial none steps

/-! ## A model -/

inductive Story.ModelStep (m : Model) where
  /-- History: events already recorded. Policies do not react to them. -/
  | given (n : m.signature.aggregates.Name) (id : (m.signature.aggregates.of n).Id)
      (events : List (m.signature.aggregates.of n).Event)
  /-- Send a command, then let everything that follows from it run. -/
  | when (s : Send m.signature.aggregates)
  /-- Send a command a decision answers. `rejected` is the rejection it must give, if any. -/
  | decide (d : Decision m.signature.aggregates) (actor : d.Actor) (c : d.Command)
      (rejected : Option d.Rejection := none)
  /-- The events recorded on this instance since it was last asserted are exactly these. -/
  | recorded (n : m.signature.aggregates.Name) (id : (m.signature.aggregates.of n).Id)
      (events : List (m.signature.aggregates.of n).Event)
  /-- The last command sent was rejected with this. -/
  | rejected (n : m.signature.aggregates.Name) (rejection : (m.signature.aggregates.of n).Rejection)
  /-- This command, sent now, would be answered with this reply. -/
  | replies (s : Send m.signature.aggregates) (reply : (m.signature.aggregates.of s.to).Reply)
  /-- An instance's state is this. -/
  | state (n : m.signature.aggregates.Name) (id : (m.signature.aggregates.of n).Id)
      (state : (m.signature.aggregates.of n).State)
  /-- A view's state at a key is this. -/
  | view (v : View m.signature.aggregates) (key : v.Key) (state : v.State)
  /-- A view emitted exactly these events at a key. -/
  | emitted (v : View m.signature.aggregates) (key : v.Key) (events : List v.Event)
  /-- This call to an outside system is waiting for an answer. -/
  | call (c : m.signature.Call)
  /-- The outside system answers the call. -/
  | answer (c : m.signature.Call) (reply : m.signature.Reply c)
  /-- A saga's run stands here. -/
  | saga (saga : m.signature.Saga) (status : SagaStatus m.signature)
  /-- Time passes: scheduled commands that are due are sent. -/
  | pass (duration : Time)
  /-- Anything else about the world. -/
  | holds (what : String) (check : World m.signature → Bool)
  /-- The next moves of the scenario the story follows happen: one, unless said otherwise. -/
  | next (moves : Nat := 1)

namespace Story

variable {m : Model}

structure Progress (m : Model) where
  world : World m.signature
  /-- The log entries a step has asserted, by where they sit in the log. -/
  asserted : List Nat
  /-- The last command's rejection, until a step asserts it. -/
  pending : Option ((n : m.signature.aggregates.Name) × (m.signature.aggregates.of n).Rejection)

/-- The events on one instance that no step has asserted yet. -/
def unasserted (log : List (Emitted m.signature.aggregates)) (asserted : List Nat)
    (n : m.signature.aggregates.Name) (id : (m.signature.aggregates.of n).Id) :
    List (Nat × (m.signature.aggregates.of n).Event) :=
  log.filterMap fun e =>
    if h : e.source = n then
      if h ▸ e.id = id ∧ e.seq ∉ asserted then some (e.seq, h ▸ e.event) else none
    else none

def fuel : Nat := 1000

def stepModel (p : Progress m) : ModelStep m → Except String (Progress m)
  | .given n id events =>
    let recorded := p.world.toRecorded.record p.world.now n id events
    let seqs := (recorded.log.drop p.world.log.length).map (·.seq)
    .ok { p with world := { p.world with toRecorded := recorded }, asserted := p.asserted ++ seqs }
  | .when s =>
    if p.pending.isSome then .error "a rejection was not asserted before the next command"
    else
      let pending :=
        match p.world.toRecorded.outcome p.world.now s with
        | .ok _ => none
        | .error r => some ⟨s.to, r⟩
      .ok { p with world := m.play fuel p.world (.send s), pending }
  | .decide d actor c rejected =>
    if p.pending.isSome then .error "a rejection was not asserted before the next command"
    else
      match d.decide ⟨actor, p.world.now⟩ p.world.state c, rejected with
      | .ok _, none => .ok { p with world := m.play fuel p.world (.decide d actor c) }
      | .error actual, some expected =>
        if actual = expected then .ok p else .error s!"{d.name} gave another rejection"
      | .ok _, some _ => .error s!"{d.name} was not rejected"
      | .error _, none => .error s!"{d.name} was rejected"
  | .recorded n id events =>
    let found := unasserted p.world.log p.asserted n id
    if found.map (·.2) = events then .ok { p with asserted := p.asserted ++ found.map (·.1) }
    else .error "the events recorded are not the ones expected"
  | .rejected n rejection =>
    match p.pending with
    | some ⟨n', actual⟩ =>
      if h : n' = n then
        if h ▸ actual = rejection then .ok { p with pending := none }
        else .error "the command gave another rejection"
      else .error "the command was rejected by another aggregate"
    | none => .error "the command was not rejected"
  | .replies s reply =>
    let a := m.signature.aggregates.of s.to
    let id := a.keyOf s.command
    match p.world.toRecorded.outcome p.world.now s with
    | .error _ => .error "the command would be rejected"
    | .ok es =>
      if a.reply (a.apply (p.world.state s.to id) es p.world.now) s.command = reply then .ok p
      else .error "the reply is not the one expected"
  | .state n id state =>
    if p.world.state n id = state then .ok p else .error "the state is not the one expected"
  | .view v key state =>
    if v.stateAt p.world.log key = state then .ok p
    else .error s!"{v.name} is not in the state expected"
  | .emitted v key events =>
    if v.emittedAt p.world.log key = events then .ok p
    else .error s!"{v.name} did not emit the events expected"
  | .call c =>
    if c ∈ m.waiting p.world then .ok p else .error "no such call is waiting"
  | .answer c reply =>
    match m.answer p.world c reply with
    | some w => .ok { p with world := m.settle fuel w }
    | none => .error "no such call is waiting to be answered"
  | .saga saga status =>
    if p.world.sagas saga = status then .ok p else .error "the saga does not stand where expected"
  | .pass duration => .ok { p with world := m.pass fuel p.world duration }
  | .holds what check => if check p.world then .ok p else .error s!"does not hold: {what}"
  | .next _ => .error "this story follows no scenario"

def runModel (p : Progress m) : List (ModelStep m) → Nat → Except String Unit
  | [], _ =>
    if p.pending.isSome then .error "a rejection was never asserted"
    else if (m.waiting p.world).length ≠ 0 then .error "a call was never answered"
    else if p.world.log.any (fun e => e.seq ∉ p.asserted) then
      .error "an event was recorded that no step asserts"
    else .ok ()
  | step :: rest, index =>
    match stepModel p step with
    | .ok p' => runModel p' rest (index + 1)
    | .error why => .error s!"step {index + 1}: {why}"

/-- A move of a scenario, as the story step that makes it. -/
def stepOf : Model.Move m → Option (ModelStep m)
  | .send s => some (.when s)
  | .decide d actor c => some (.decide d actor c)
  | .answer c reply => some (.answer c reply)
  | .pass duration => some (.pass duration)
  | .redeliver _ => none

/-- Makes the next moves of a scenario. -/
def advance (p : Progress m) : Nat → List (Model.Move m) →
    Except String (Progress m × List (Model.Move m))
  | 0, scenario => .ok (p, scenario)
  | _ + 1, [] => .error "the scenario has no more moves"
  | moves + 1, move :: rest =>
    match stepOf move with
    | none => advance { p with world := m.play fuel p.world move } moves rest
    | some step =>
      match stepModel p step with
      | .ok p' => advance p' moves rest
      | .error why => .error why

def followModel (p : Progress m) (scenario : List (Model.Move m)) :
    List (ModelStep m) → Nat → Except String Unit
  | [], index =>
    if scenario.length ≠ 0 then .error "the story ends before the scenario does"
    else runModel p [] index
  | .next moves :: rest, index =>
    match advance p moves scenario with
    | .ok (p', scenario') => followModel p' scenario' rest (index + 1)
    | .error why => .error s!"step {index + 1}: {why}"
  | step :: rest, index =>
    match stepModel p step with
    | .ok p' => followModel p' scenario rest (index + 1)
    | .error why => .error s!"step {index + 1}: {why}"

end Story

/--
Runs a story that follows a scenario: `.next` makes the scenario's next move,
and the steps between say what must be true there. The moves are the
scenario's own, so a theorem about the scenario is about this story.
-/
def Model.following (m : Model) (scenario : List (Model.Move m))
    (steps : List (Story.ModelStep m)) : Except String Unit :=
  Story.followModel { world := World.start m.signature, asserted := [], pending := none }
    scenario steps 0

/-- Whether a story that follows a scenario passes. -/
def Model.follows (m : Model) (scenario : List (Model.Move m))
    (steps : List (Story.ModelStep m)) : Bool :=
  match m.following scenario steps with
  | .ok _ => true
  | .error _ => false

/-- Runs a story on the model, in memory. `.ok ()` when every step holds. -/
def Model.story (m : Model) (steps : List (Story.ModelStep m)) : Except String Unit :=
  Story.runModel { world := World.start m.signature, asserted := [], pending := none } steps 0

/-- Whether a story passes. `m.story` says why one does not. -/
def Model.passes (m : Model) (steps : List (Story.ModelStep m)) : Bool :=
  match m.story steps with
  | .ok _ => true
  | .error _ => false

end Alchemy
