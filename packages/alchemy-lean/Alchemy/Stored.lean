import Alchemy.Engine

/-!
# A model, kept in stores

The engine in `Alchemy.Engine` is a function on a `World` held in one piece.
This is the same engine with each part of the world behind a service: the
aggregates' states in a `Store`, the events not yet delivered in a `Delivery`,
what is part-way through in `Processes`, and the time in a `Clock`. It loads
one instance, decides, and commits the state the events leave: it never replays
a history.

Each service has a law, stated against what a store holds. The engine is
written once, for any services, and one theorem carries every proof across:
on lawful services, whatever the engine does is steps the model can take. So a
rule proved of the model holds of the model as it is stored, wherever that is.
-/
namespace Alchemy

/-- How code acts on what it runs against: what it answers, and what it leaves. -/
structure Acts (μ : Type → Type) [Monad μ] (S : Type) where
  eval : {α : Type} → μ α → S → α × S
  eval_pure : ∀ {α : Type} (a : α) (s : S), eval (pure a) s = (a, s)
  eval_bind : ∀ {α β : Type} (x : μ α) (f : α → μ β) (s : S),
    eval (x >>= f) s = eval (f (eval x s).1) (eval x s).2

variable {σ : Signature}

/-- What is part-way through: reactions and runs, where each saga stands, and what is scheduled. -/
structure Process (σ : Signature) where
  fibers : List (Fiber σ)
  sagas : σ.Saga → SagaStatus σ
  signals : σ.Saga → List σ.Signal
  schedule : List (Time × Send σ.aggregates)

namespace Process

/-- Before anything has run. -/
def start (σ : Signature) : Process σ where
  fibers := []
  sagas := fun _ => .notStarted
  signals := fun _ => []
  schedule := []

/-- Ends a fiber: a saga's run takes the status. -/
def finish (P : Process σ) (owner : Option σ.Saga) (status : SagaStatus σ) : Process σ :=
  match owner with
  | none => P
  | some saga => { P with sagas := update P.sagas saga status }

/-- The calls waiting for an outside system's answer, oldest first. -/
def waiting (P : Process σ) : List σ.Call :=
  P.fibers.filterMap fun f =>
    match f.program with
    | .call c _ => some c
    | _ => none

end Process

/-- The part of a world that is part-way through. -/
def World.process (w : World σ) : Process σ := ⟨w.fibers, w.sagas, w.signals, w.schedule⟩

/-- An event as a store hands it on: without its place in a log nobody keeps. -/
def Emitted.unplaced {g : Aggregates} (e : Emitted g) : Emitted g := { e with seq := 0 }

/--
What is read from a model, kept up as events are delivered: views, tables,
whatever a reader asks for. It is a state and how one event changes it.
-/
structure ReadSide (g : Aggregates) where
  State : Type
  initial : State
  apply : State → Emitted g → State

/-- A model nothing is read from. -/
def ReadSide.none (g : Aggregates) : ReadSide g := ⟨Unit, (), fun _ _ => ()⟩

/-- What the stores hold, as the model sees it. -/
structure Held (σ : Signature) (reads : ReadSide σ.aggregates) where
  /-- Every instance's state. -/
  state : States σ.aggregates
  /-- The events committed and not yet delivered, oldest first. -/
  pending : List (Emitted σ.aggregates)
  process : Process σ
  now : Time
  /-- What is read, after every event delivered so far. -/
  read : reads.State

/-- Before anything is stored. -/
def Held.start (σ : Signature) (reads : ReadSide σ.aggregates) : Held σ reads where
  state := fun n _ => (σ.aggregates.of n).initial
  pending := []
  process := .start σ
  now := 0
  read := reads.initial

/-! ## The services -/

/-- Where each instance's state is kept. -/
structure Store (μ : Type → Type) (g : Aggregates) where
  load : (n : g.Name) → (g.of n).Id → μ (g.of n).State
  /-- Keeps the state a command left, and hands its events to delivery, together. -/
  commit : (n : g.Name) → (g.of n).Id → (g.of n).State → List (g.of n).Event → Time → μ Unit

/-- How committed events reach the policies. -/
structure Delivery (μ : Type → Type) (g : Aggregates) where
  /-- Takes the oldest event not yet delivered, if there is one. -/
  next : μ (Option (Emitted g))

/-- Where what is part-way through is kept between requests. -/
structure Processes (μ : Type → Type) (σ : Signature) where
  read : μ (Process σ)
  keep : Process σ → μ Unit

/-- What time it is. -/
structure Clock (μ : Type → Type) where
  now : μ Time

/-- Everything a model asks of its host. -/
structure Services (μ : Type → Type) (σ : Signature) (reads : ReadSide σ.aggregates) where
  store : Store μ σ.aggregates
  delivery : Delivery μ σ.aggregates
  processes : Processes μ σ
  clock : Clock μ
  /-- Each outside system the model calls. -/
  call : (c : σ.Call) → μ (σ.Reply c)
  /-- Hands a delivered event to whatever is read from the model. -/
  project : Emitted σ.aggregates → μ Unit
  /-- What is read from the model, as it stands. -/
  look : μ reads.State

/-! ## Their laws -/

section Laws

variable {μ : Type → Type} [Monad μ] {S : Type} (acts : Acts μ S)
  {reads : ReadSide σ.aggregates} (held : S → Held σ reads) (sound : S → Prop)

/-- Code that answers something about what is held, and changes none of it. -/
def Reads {α : Type} (x : μ α) (answer : Held σ reads → α) : Prop :=
  ∀ s, sound s →
    (acts.eval x s).1 = answer (held s) ∧ held (acts.eval x s).2 = held s ∧ sound (acts.eval x s).2

/-- Code that changes what is held in exactly this way. -/
def Writes {α : Type} (x : μ α) (change : Held σ reads → Held σ reads) : Prop :=
  ∀ s, sound s → held (acts.eval x s).2 = change (held s) ∧ sound (acts.eval x s).2

/-- A store answers the state it holds, and a commit changes one instance and adds its events. -/
structure Store.Lawful (store : Store μ σ.aggregates) : Prop where
  load : ∀ n id, Reads acts held sound (store.load n id) fun h => h.state n id
  commit : ∀ n id state events time,
    Writes acts held sound (store.commit n id state events time) fun h =>
      { h with
        state := h.state.set n id state
        pending := h.pending ++ events.map fun e => ⟨n, id, e, 0, time⟩ }

/-- Delivery hands on the oldest pending event, once. -/
structure Delivery.Lawful (delivery : Delivery μ σ.aggregates) : Prop where
  next : ∀ s, sound s →
    (acts.eval delivery.next s).1 = (held s).pending.head? ∧
      held (acts.eval delivery.next s).2 = { held s with pending := (held s).pending.tail } ∧
      sound (acts.eval delivery.next s).2

/-- What is kept reads back. -/
structure Processes.Lawful (processes : Processes μ σ) : Prop where
  read : Reads acts held sound processes.read fun h => h.process
  keep : ∀ P, Writes acts held sound (processes.keep P) fun h => { h with process := P }

/-- The clock answers the time. -/
structure Clock.Lawful (clock : Clock μ) : Prop where
  now : Reads acts held sound clock.now fun h => h.now

/-- Every service keeps its law, and calling outside changes nothing the model holds. -/
structure Services.Lawful (services : Services μ σ reads) : Prop where
  store : services.store.Lawful acts held sound
  delivery : services.delivery.Lawful acts held sound
  processes : services.processes.Lawful acts held sound
  clock : services.clock.Lawful acts held sound
  call : ∀ c, Writes acts held sound (services.call c) fun h => h
  /-- A delivered event changes what is read, and nothing else. -/
  project : ∀ e, Writes acts held sound (services.project e) fun h =>
    { h with read := reads.apply h.read e }
  look : Reads acts held sound services.look fun h => h.read

end Laws

/-! ## The engine -/

/-- A model run on services. -/
structure Engine (μ : Type → Type) (m : Model) (reads : ReadSide m.signature.aggregates) where
  services : Services μ m.signature reads
  /-- How many steps one request may set off. -/
  fuel : Nat := 1000
  /-- How many outside calls one request may make. -/
  calls : Nat := 100

namespace Engine

variable {μ : Type → Type} [Monad μ] {m : Model} {reads : ReadSide m.signature.aggregates}
  (e : Engine μ m reads)

/-- Sends one command to its instance: load, decide, and commit what the events leave. -/
def record (s : Send m.signature.aggregates) : μ (Answer m.signature.aggregates s.to) :=
  e.services.clock.now >>= fun now =>
  e.services.store.load s.to ((m.signature.aggregates.of s.to).keyOf s.command) >>= fun state =>
  match (m.signature.aggregates.of s.to).decide ⟨s.actor, now⟩ state s.command with
  | .ok events =>
    e.services.store.commit s.to ((m.signature.aggregates.of s.to).keyOf s.command)
      ((m.signature.aggregates.of s.to).apply state events now) events now >>= fun _ =>
    pure (.ok events)
  | .error rejection => pure (.error rejection)

/-- A fiber's next step: what is part-way through after it, and the fibers that replace it. -/
def advance (P : Process m.signature) (f : Fiber m.signature) :
    μ (Option (Process m.signature × List (Fiber m.signature))) :=
  match f.program with
  | .pure () => pure (some (P.finish f.owner .completed, []))
  | .fail failure =>
    match f.undo with
    | [] => pure (some (P.finish f.owner (.failed failure), []))
    | u :: rest => e.record (u failure) >>= fun _ => pure (some (P, [{ f with undo := rest }]))
  | .send s k => e.record s >>= fun answer => pure (some (P, [{ f with program := k answer }]))
  | .call _ _ => pure none
  | .await k =>
    pure (match f.owner with
      | none => none
      | some saga =>
        match P.signals saga with
        | [] => none
        | signal :: rest =>
          some ({ P with signals := update P.signals saga rest }, [{ f with program := k signal }]))
  | .compensate u k => pure (some (P, [{ f with program := k, undo := u :: f.undo }]))
  | .start saga input k =>
    pure (match P.sagas saga with
      | .notStarted =>
        some ({ P with sagas := update P.sagas saga .running },
          [{ f with program := k }, { owner := some saga, program := m.saga saga input, undo := [] }])
      | _ => some (P, [{ f with program := k }]))
  | .signal saga signal k =>
    pure (some ({ P with signals := update P.signals saga (P.signals saga ++ [signal]) },
      [{ f with program := k }]))
  | .schedule after s k =>
    e.services.clock.now >>= fun now =>
    pure (some ({ P with schedule := P.schedule ++ [(now + after, s)] }, [{ f with program := k }]))

/-- The first fiber that can take a step takes it. -/
def tryFibers (P : Process m.signature) :
    List (Fiber m.signature) → List (Fiber m.signature) → μ (Option (Process m.signature))
  | _, [] => pure none
  | before, f :: after =>
    e.advance P f >>= fun
      | some (P', fs) => pure (some { P' with fibers := before ++ fs ++ after })
      | none => tryFibers P (before ++ [f]) after

/-- One step: the oldest pending event reaches the policies, or else a fiber goes on. -/
def stepOnce (P : Process m.signature) : μ (Option (Process m.signature)) :=
  e.services.delivery.next >>= fun
    | some event =>
      e.services.project event >>= fun _ =>
      pure (some { P with
        fibers := P.fibers ++ m.policies.map fun p =>
          { owner := none, program := p.react [] event, undo := [] } })
    | none => e.tryFibers P [] P.fibers

/-- Runs until nothing can go on, or the fuel runs out. -/
def settle : Nat → Process m.signature → μ (Process m.signature)
  | 0, P => pure P
  | fuel + 1, P =>
    e.stepOnce P >>= fun
      | none => pure P
      | some P' => settle fuel P'

/-- Calls the outside systems the model is waiting on, until none is left. -/
def answerCalls : Nat → Process m.signature → μ (Process m.signature)
  | 0, P => pure P
  | calls + 1, P =>
    match P.waiting with
    | [] => pure P
    | c :: _ =>
      e.services.call c >>= fun reply =>
      match m.answerGo c reply P.fibers with
      | some fibers => e.settle e.fuel { P with fibers } >>= answerCalls calls
      | none => pure P

/--
Send the model a command. Answers what the aggregate answered, once every
policy that reacts has run and every outside call was made.
-/
def send (s : Send m.signature.aggregates) : μ (Answer m.signature.aggregates s.to) :=
  e.services.processes.read >>= fun P =>
  e.record s >>= fun answer =>
  e.settle e.fuel P >>= fun P =>
  e.answerCalls e.calls P >>= fun P =>
  e.services.processes.keep P >>= fun _ =>
  pure answer

/-- Sends the scheduled commands that are due, one at a time, letting each settle. -/
def fireDue : Nat → Process m.signature → μ (Process m.signature)
  | 0, P => pure P
  | count + 1, P =>
    e.services.clock.now >>= fun now =>
    match m.nextDue now P.schedule with
    | none => pure P
    | some (before, x, after) =>
      e.record x.2 >>= fun _ =>
      e.settle e.fuel { P with schedule := before ++ after } >>= fireDue count

/-- The clock has moved: send what is now due, and everything that follows. -/
def wake : μ Unit :=
  e.services.processes.read >>= fun P =>
  e.fireDue e.fuel P >>= fun P =>
  e.answerCalls e.calls P >>= fun P =>
  e.services.processes.keep P

/-- One instance's state. -/
def state (n : m.signature.aggregates.Name) (id : (m.signature.aggregates.of n).Id) :
    μ (m.signature.aggregates.of n).State :=
  e.services.store.load n id

/-- What is read from the model, as it stands. -/
def look : μ reads.State := e.services.look

/-- Send a command, and answer its caller: a rejection, or the aggregate's reply. -/
def ask (s : Send m.signature.aggregates) :
    μ (Except (m.signature.aggregates.of s.to).Rejection (m.signature.aggregates.of s.to).Reply) :=
  e.send s >>= fun answer =>
  e.services.store.load s.to ((m.signature.aggregates.of s.to).keyOf s.command) >>= fun state =>
  pure (answer.map fun _ => (m.signature.aggregates.of s.to).reply state s.command)

end Engine

end Alchemy
