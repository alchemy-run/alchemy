import Alchemy.Engine

/-!
An Api: what one audience may send and read. Who is asking is the actor each
command and read is given, so a session is an argument, not a setting.
-/
namespace Alchemy

structure Api (m : Model) where
  name : String
  /-- The commands this audience may send. -/
  accepts : Send m.signature.aggregates → Bool
  decisions : List (Decision m.signature.aggregates) := []
  views : List (View m.signature.aggregates) := []
  streams : List (Stream m.signature.aggregates) := []
  queries : List (Query m.signature.aggregates) := []

/-- Sends a command through an Api: `none` when the Api does not offer it. -/
def Api.send {m : Model} (api : Api m) (w : World m.signature) (s : Send m.signature.aggregates)
    (fuel : Nat := 1000) : Option (World m.signature) :=
  if api.accepts s then some (m.play fuel w (.send s)) else none

end Alchemy
