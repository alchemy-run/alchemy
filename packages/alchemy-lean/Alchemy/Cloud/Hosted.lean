import Alchemy.Engine
import Alchemy.Cloud.Layer
import Lean.Data.Json

/-!
# A model, hosted

A domain model run by a host. Every command it is sent and every answer an
outside system gives is written to a `Journal` service before it is applied, so
the model is whatever its journal replays to. The outside systems the model
calls are services too: a host says where each one is by the layers it gives.
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

/-- Where a model's history is kept: lines, in the order they were written. -/
structure Journal (access : Access K) where
  read : Run access Never (List String)
  append : String → Run access Never Unit

/-- A model, and how a host runs it. -/
structure Hosted (m : Model) (R : Service K) where
  /-- What callers send. -/
  Input : Type
  /-- The command an input is. -/
  command : Input → Send m.signature.aggregates
  /-- Each outside system the model calls, as code that uses services. -/
  call : (c : m.signature.Call) → Effect R Never (m.signature.Reply c)
  [input : Text Input]
  [reply : (c : m.signature.Call) → Text (m.signature.Reply c)]

namespace Hosted

variable {m : Model} {R : Service K}

def fuel : Nat := 1000

/-- The world after one line of the journal. A line that does not read is skipped. -/
def apply (hosted : Hosted m R) (w : Alchemy.World m.signature) (line : String) :
    Alchemy.World m.signature :=
  let text := toString (line.drop 2)
  if line.startsWith "> " then
    match hosted.input.read text with
    | some input => m.play fuel w (.send (hosted.command input))
    | none => w
  else
    match m.waiting w with
    | c :: _ =>
      match (hosted.reply c).read text with
      | some reply => m.play fuel w (.answer c reply)
      | none => w
    | [] => w

/-- The world a journal leaves. -/
def replay (hosted : Hosted m R) (lines : List String) : Alchemy.World m.signature :=
  lines.foldl hosted.apply (World.start m.signature)

variable [Uses R (Journal (K := K))]

/-- The model as its journal has it. -/
def world (hosted : Hosted m R) : Effect R Never (Alchemy.World m.signature) := do
  let lines ← use Journal (·.read)
  return hosted.replay lines

/-- Calls the outside systems the model is waiting on, until none is left. -/
def answerCalls (hosted : Hosted m R) :
    Nat → Alchemy.World m.signature → Effect R Never (Alchemy.World m.signature)
  | 0, w => pure w
  | calls + 1, w =>
    match m.waiting w with
    | [] => pure w
    | c :: _ => do
      let reply ← hosted.call c
      use Journal (·.append ("< " ++ (hosted.reply c).write reply))
      hosted.answerCalls calls (m.play fuel w (.answer c reply))

/--
Send the model a command. Answers what the aggregate answered, and the world
once every policy that reacts has run and every outside call was made.
-/
def send (hosted : Hosted m R) (input : hosted.Input) :
    Effect R Never
      (Answer m.signature.aggregates (hosted.command input).to × Alchemy.World m.signature) := do
  let before ← hosted.world
  let command := hosted.command input
  use Journal (·.append ("> " ++ hosted.input.write input))
  let after ← hosted.answerCalls 100 (m.play fuel before (.send command))
  return (before.toRecorded.outcome before.now command, after)

end Hosted

end Alchemy.Cloud
