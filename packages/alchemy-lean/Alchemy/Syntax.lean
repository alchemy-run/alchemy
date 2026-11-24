import Lean
import Alchemy.Model

/-!
# `model … where`

One declaration for a whole domain model: its aggregates, the outside systems
it calls, its policies, its views and its projections. It writes the
definitions a model is made of, and the theorems that come for free.

An aggregate is named after a namespace that holds its `Command`, `Event`,
`Rejection` and `State` types and its `key`, `decide` and `evolve` functions.
-/

namespace Alchemy

open Lean Parser

declare_syntax_cat modelItem (behavior := both)

syntax callBinder := "(" ident+ " : " term ")"

/-- One case: `| pattern, pattern => result`. -/
syntax modelAlt := ppLine "| " term,+ " => " term

/-- An aggregate, by the namespace that defines it. -/
syntax &"aggregate " ident : modelItem
/-- A call to a system outside the model, and what it answers. -/
syntax &"call " ident callBinder* " : " term : modelItem
/-- What to do whenever an aggregate records an event: `| id, event => …`. -/
syntax &"policy " ident &" on " ident modelAlt+ : modelItem
/-- A value folded over an aggregate's events: `| value, event => …`. -/
syntax &"view " ident &" on " ident " : " term " := " term modelAlt+ : modelItem
/-- Rows written for an aggregate's events: `| id, event => […]`. -/
syntax &"projection " ident &" on " ident " : " term modelAlt+ : modelItem

syntax (name := modelCommand) "model " ident " where" many1Indent(modelItem) : command

private def under (parent : Ident) (child : Name) : Ident :=
  mkIdentFrom parent (parent.getId ++ child)

private def rooted (name : Ident) (child : Name := .anonymous) : Ident :=
  mkIdentFrom name (`_root_ ++ name.getId ++ child)

private def text (name : Ident) : StrLit := Syntax.mkStrLit (toString name.getId)

/-- The cases of a block as `match` alternatives, with one more at the end for everything else. -/
private def withFallback (alts : Array (TSyntax ``modelAlt)) (fallback : TSyntax ``Term.matchAltExpr) :
    MacroM (Array (TSyntax ``Term.matchAlt)) := do
  let alts ← alts.mapM fun alt =>
    match alt with
    | `(modelAlt| | $patterns,* => $result) => `(Term.matchAltExpr| | $patterns,* => $result)
    | _ => Macro.throwUnsupported
  return (alts.push fallback).map fun alt => ⟨alt.raw⟩

/-- A command, allowed alternatives that can never match. -/
private def lenient (command : Command) : MacroM Command :=
  `(command| set_option match.ignoreUnusedAlts true in $command:command)

macro_rules
  | `(model $m:ident where $items*) => do
    let mut aggregates : Array Ident := #[]
    let mut callCtors := #[]
    let mut replyAlts := #[]
    let mut callDefs : Array Command := #[]
    let mut later : Array Command := #[]
    let mut policies : Array Ident := #[]
    let mut views : Array Ident := #[]
    let mut projections : Array Ident := #[]
    let name := mkIdent `Name
    let signature := mkIdent `Signature
    let aggregatesId := mkIdent `Aggregates
    let callId := mkIdent `Call
    for item in items do
      match item with
      | `(modelItem| aggregate $a:ident) => aggregates := aggregates.push a
      | `(modelItem| call $c:ident $binders* : $reply:term) =>
        let mut ctorBinders := #[]
        let mut arguments : Array Ident := #[]
        let mut types : Array Term := #[]
        for binder in binders do
          match binder with
          | `(callBinder| ($ids* : $type)) =>
            ctorBinders := ctorBinders.push (← `(bracketedBinder| ($ids* : $type)))
            arguments := arguments ++ ids
            types := types ++ ids.map fun _ => type
          | _ => Macro.throwUnsupported
        let ctorType ← types.foldrM (fun type rest => `($type → $rest)) (← `($callId))
        callCtors := callCtors.push (← `(Command.ctor| | $c:ident : $ctorType))
        let ctor := under callId c.getId
        replyAlts := replyAlts.push (← `(Term.matchAltExpr| | $ctor:ident .. => $reply))
        callDefs := callDefs.push (← `(command|
          def $c:ident $ctorBinders* : Alchemy.Program $signature $reply :=
            Alchemy.Program.request (σ := $signature) ($ctor:ident $arguments*)))
      | `(modelItem| policy $p:ident on $a:ident $alts:modelAlt*) =>
        policies := policies.push p
        let alts ← withFallback alts (← `(Term.matchAltExpr| | _, _ => pure ()))
        later := later.push (← lenient <| ← `(command|
          def $p:ident : Alchemy.Policy $signature :=
            Alchemy.Policy.on $(text p) $(under name a.getId)
              fun (id : String) (event : $(rooted a `Event)) =>
                match id, event with $alts:matchAlt*))
      | `(modelItem| view $v:ident on $a:ident : $type := $initial:term $alts:modelAlt*) =>
        views := views.push v
        let step := under v `step
        let alts ← withFallback alts (← `(Term.matchAltExpr| | state, _ => state))
        later := later.push (← lenient <| ← `(command|
          def $step:ident (state : $type) : Alchemy.Emitted $aggregatesId → $type
            | ⟨$(under name a.getId), _, event, _, _⟩ =>
              match state, (event : $(rooted a `Event)) with $alts:matchAlt*
            | _ => state))
        later := later.push (← `(command|
          abbrev $v:ident : Alchemy.View $aggregatesId :=
            Alchemy.View.fold $(text v) $initial $step))
        later := later.push (← `(command|
          /-- The view is exactly its step folded over the log, whatever was recorded. -/
          theorem $(under v `exact):ident (log : List (Alchemy.Emitted $aggregatesId)) :
              Alchemy.View.stateAt $v log () = log.foldl $step $initial :=
            Alchemy.View.fold_exact _ _ _ log))
      | `(modelItem| projection $p:ident on $a:ident : $row:term $alts:modelAlt*) =>
        projections := projections.push p
        let rows := under p `rows
        let alts ← withFallback alts (← `(Term.matchAltExpr| | _, _ => []))
        later := later.push (← lenient <| ← `(command|
          def $rows:ident : Alchemy.Emitted $aggregatesId → List $row
            | ⟨$(under name a.getId), id, event, _, _⟩ =>
              match (id : String), (event : $(rooted a `Event)) with $alts:matchAlt*
            | _ => []))
        later := later.push (← `(command|
          abbrev $p:ident : Alchemy.Projection $aggregatesId :=
            Alchemy.Projection.each $(text p) $rows))
        later := later.push (← `(command|
          /-- The projection is given exactly each event's rows: none missed, none twice. -/
          theorem $(under p `exact):ident (log : List (Alchemy.Emitted $aggregatesId)) :
              Alchemy.Projection.table $p log = log.flatMap $rows :=
            Alchemy.Projection.each_exact _ _ log))
      | _ => Macro.throwUnsupported
    let mut commands : Array Command := #[]
    -- Each aggregate, from the namespace that defines it.
    for a in aggregates do
      commands := commands.push (← `(command|
        abbrev $a:ident : Alchemy.Aggregate where
          name := $(text a)
          Id := String
          State := $(rooted a `State)
          Command := $(rooted a `Command)
          Event := $(rooted a `Event)
          Rejection := $(rooted a `Rejection)
          Actor := Unit
          initial := {}
          keyOf := $(rooted a `key)
          decide := fun _ state command => $(rooted a `decide) state command
          evolve := fun state event _ => $(rooted a `evolve) state event))
    commands := commands.push (← `(command| namespace $m))
    let nameCtors ← aggregates.mapM fun a => `(Command.ctor| | $a:ident)
    commands := commands.push (← `(command|
      /-- The aggregates of the model. -/
      inductive $name where $nameCtors* deriving DecidableEq, Repr))
    let ofAlts ← aggregates.mapM fun a =>
      `(Term.matchAltExpr| | $(under name a.getId):ident => $(rooted a))
    commands := commands.push (← `(command|
      abbrev $aggregatesId : Alchemy.Aggregates where
        Name := $name
        of := fun name => match name with $ofAlts:matchAlt*))
    commands := commands.push (← `(command|
      /-- The calls the model makes to systems outside it. -/
      inductive $callId where $callCtors* deriving DecidableEq, Repr))
    commands := commands.push (← `(command|
      abbrev $(mkIdent `Reply) : $callId → Type := fun c => match c with $replyAlts:matchAlt*))
    commands := commands.push (← `(command|
      abbrev $signature : Alchemy.Signature where
        aggregates := $aggregatesId
        Call := $callId
        Reply := $(mkIdent `Reply)
        Saga := Unit
        SagaInput := Unit
        Signal := Unit
        Failure := Unit))
    commands := commands ++ callDefs
    for a in aggregates do
      commands := commands.push (← `(command|
        /-- Send this aggregate a command, from a policy. -/
        def $(under a `send):ident (command : $(rooted a `Command)) :
            Alchemy.Program $signature Unit :=
          Alchemy.Program.tell ⟨$(under name a.getId), (), command⟩))
    commands := commands ++ later
    commands := commands.push (← `(command| end $m))
    commands := commands.push (← `(command|
      abbrev $m:ident : Alchemy.Model where
        name := $(text m)
        signature := $(under m `Signature)
        policies := [$[$(policies.map (under m ·.getId))],*]
        views := [$[$(views.map (under m ·.getId))],*]
        projections := [$[$(projections.map (under m ·.getId))],*]))
    return mkNullNode commands

end Alchemy
