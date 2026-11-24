import Alchemy

/-!
# A model that never comes to rest

A counter whose policy reacts to every bump by bumping again. `comes_to_rest`
refuses it, and says which event keeps feeding itself.
-/

open Alchemy

aggregate Counter where
  command
    | bump (id : String)
        records bumped

  event
    | bumped

  rejection
    | never

  state
    count : Nat := 0

  decide
    | _, .bump _ => .ok [.bumped]

  evolve
    | s, .bumped => { s with count := s.count + 1 }

model Loop where
  aggregate Counter

  -- whenever the counter is bumped, bump it again
  policy Again on Counter
    | id, .bumped => Counter.send (.bump id)

/--
error: Loop may never come to rest: no weights hold together, because some reaction leads back to the event it reacts to. These kept growing: [Counter.Event.bumped]
-/
#guard_msgs in
comes_to_rest Loop
