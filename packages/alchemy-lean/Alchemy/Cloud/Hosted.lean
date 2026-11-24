import Alchemy.Engine
import Alchemy.Cloud.Layer
import Lean.Data.Json

/-!
# A model, hosted

A domain model run by a host. Every command it is sent and every answer an
outside system gives is written to a journal before it is applied, so the model
is whatever its journal replays to.

Whatever a journal holds, it replays to a world the model can reach. So every
rule proved of the model holds of the model as it is deployed.
-/

namespace Alchemy.Cloud

open Lean (Json ToJson FromJson toJson fromJson?)

variable {K : Type} [Cloud K]

/-- A value as text for a journal, and back. -/
class Text (α : Type) where
  write : α → String
  read : String → Option α

instance {α : Type} [ToJson α] [FromJson α] : Text α where
  write a := (toJson a).compress
  read text := do (fromJson? (← (Json.parse text).toOption)).toOption

/-- One line of a model's history: something a caller sent, or an answer an outside system gave. -/
inductive Journal.Line where
  | input (text : String)
  | answer (text : String)
deriving DecidableEq, Repr

/-- Where a model's history is kept: lines, in the order they were written. -/
structure Journal (access : Access K) where
  read : Run access Never (List Journal.Line)
  append : Journal.Line → Run access Never Unit

/-- How a model is spoken to: what callers send, and how its history is written down. -/
structure Served (m : Model) where
  /-- What callers send. -/
  Input : Type
  /-- The command an input is. -/
  command : Input → Send m.signature.aggregates
  /-- Callers are only offered commands the model offers. -/
  offered : ∀ input, m.offered (command input) := by intro _; trivial
  [input : Text Input]
  reply : (c : m.signature.Call) → Text (m.signature.Reply c) := by
    intro c; cases c <;> exact inferInstance

namespace Served

variable {m : Model}

def fuel : Nat := 1000

/-- The world after one line of the journal. A line that does not read is skipped. -/
def apply (served : Served m) (w : Alchemy.World m.signature) :
    Journal.Line → Alchemy.World m.signature
  | .input text =>
    match served.input.read text with
    | some input => m.play fuel w (.send (served.command input))
    | none => w
  | .answer text =>
    match m.waiting w with
    | c :: _ =>
      match (served.reply c).read text with
      | some reply => m.play fuel w (.answer c reply)
      | none => w
    | [] => w

/-- The world a journal leaves. -/
def replay (served : Served m) (lines : List Journal.Line) : Alchemy.World m.signature :=
  lines.foldl served.apply (World.start m.signature)

theorem apply_reachable (served : Served m) (w : Alchemy.World m.signature) (line : Journal.Line)
    (reach : m.Reachable w) : m.Reachable (served.apply w line) := by
  cases line with
  | input text =>
    show m.Reachable (match served.input.read text with
      | some input => m.play fuel w (.send (served.command input))
      | none => w)
    split
    · exact m.play_send_reachable fuel w _ (served.offered _) reach
    · exact reach
  | answer text =>
    show m.Reachable (match m.waiting w with
      | c :: _ =>
        match (served.reply c).read text with
        | some reply => m.play fuel w (.answer c reply)
        | none => w
      | [] => w)
    split
    · split
      · exact m.play_answer_reachable fuel w _ _ reach
      · exact reach
    · exact reach

/--
Whatever a journal holds, written by this host or not, in order or not, it
replays to a world the model can reach.
-/
theorem replay_reachable (served : Served m) (lines : List Journal.Line) :
    m.Reachable (served.replay lines) := by
  unfold replay
  suffices ∀ w, m.Reachable w → m.Reachable (lines.foldl served.apply w) from this _ .start
  intro w reach
  induction lines generalizing w with
  | nil => exact reach
  | cons line rest ih => exact ih _ (served.apply_reachable w line reach)

/--
A rule each aggregate keeps holds of every instance of the deployed model,
whatever its journal holds.
-/
theorem always (served : Served m) {P : Model.Rule m.signature.aggregates}
    (initially : ∀ n, P n (m.signature.aggregates.of n).initial)
    (kept : ∀ n, (m.signature.aggregates.of n).Keeps (P n))
    (decided : ∀ d ∈ m.decisions, ∀ r (ctx : Context d.Actor) c,
      Model.Holds P r → Model.Holds P (r.decide d ctx c))
    (lines : List Journal.Line) : Model.Holds P (served.replay lines).toRecorded :=
  m.always initially kept decided _ (served.replay_reachable lines)

end Served

/-- A served model running on a host: where its journal is, and who answers its calls. -/
structure Hosted {m : Model} (served : Served m) (role : Access K) where
  journal : Journal role
  /-- Each outside system the model calls. -/
  call : (c : m.signature.Call) → Run role Never (m.signature.Reply c)

/-- Host a model: give it a journal, and say who answers each call it makes. -/
def Served.host {m : Model} (served : Served m) {role : Access K} (journal : Journal role)
    (call : (c : m.signature.Call) → Run role Never (m.signature.Reply c)) : Hosted served role :=
  { journal, call }

namespace Hosted

variable {m : Model} {served : Served m} {role : Access K}

/-- The model as its journal has it. -/
def world (hosted : Hosted served role) : Run role Never (Alchemy.World m.signature) := do
  return served.replay (← hosted.journal.read)

/-- Calls the outside systems the model is waiting on, until none is left. -/
def answerCalls (hosted : Hosted served role) :
    Nat → Alchemy.World m.signature → Run role Never (Alchemy.World m.signature)
  | 0, w => pure w
  | calls + 1, w =>
    match m.waiting w with
    | [] => pure w
    | c :: _ => do
      let reply ← hosted.call c
      hosted.journal.append (.answer ((served.reply c).write reply))
      hosted.answerCalls calls (m.play Served.fuel w (.answer c reply))

/--
Send the model a command. Answers what the aggregate answered, and the world
once every policy that reacts has run and every outside call was made.
-/
def send (hosted : Hosted served role) (input : served.Input) :
    Run role Never
      (Answer m.signature.aggregates (served.command input).to × Alchemy.World m.signature) := do
  let before ← hosted.world
  let command := served.command input
  hosted.journal.append (.input (served.input.write input))
  let after ← hosted.answerCalls 100 (m.play Served.fuel before (.send command))
  return (before.toRecorded.outcome before.now command, after)

end Hosted

end Alchemy.Cloud
