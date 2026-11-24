import Lean
import Alchemy.Attr
import Alchemy.Model
import Alchemy.Cloud.Hosted
import Alchemy.Codec

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

declare_syntax_cat aggregateItem (behavior := both)

/-- One case of a command, an event or a rejection: a name and its fields. -/
syntax caseOf := ppLine "| " rawIdent callBinder*
/-- One thing the state remembers, and what it starts as. -/
syntax fieldOf := atomic(ident " : ") term " := " term

/--
One command: its name and fields, then the events it may record and the
rejections it may answer. Both lists are checked against `decide`.
-/
syntax commandOf := ppLine "| " rawIdent callBinder*
  (&" records " rawIdent,+)? (&" rejects " rawIdent,+)?

/-- What the aggregate can be asked. The first field of each is the instance it is for. -/
syntax &"command" commandOf+ : aggregateItem
/-- What it records. -/
syntax &"event" caseOf+ : aggregateItem
/-- Why it refuses. -/
syntax &"rejection" caseOf+ : aggregateItem
/-- What it remembers. -/
syntax &"state" many1Indent(fieldOf) : aggregateItem
/-- The events a command records, or why it is refused: `| state, command => …`. -/
syntax &"decide" modelAlt+ : aggregateItem
/-- What an event does to the state: `| state, event => …`. -/
syntax &"evolve" modelAlt+ : aggregateItem
/-- What an accepted command answers its caller, from the state it left: `| state, command => …`. -/
syntax &"reply" " : " term modelAlt+ : aggregateItem
/--
Who sends its commands. With it, `decide` is given the actor first:
`| actor, state, command => …`. A policy sends as the type's default.
-/
syntax &"actor" " : " term : aggregateItem

/--
An aggregate: its commands, events, rejections and state, and how it decides,
evolves and replies. It writes a namespace of that name holding plain types and
plain functions, which is what a `model` and every theorem refer to.
-/
syntax (name := aggregateCommand) "aggregate " ident " where" many1Indent(aggregateItem) : command

/-- A command, allowed alternatives that can never match. -/
private def lenient (command : Command) : MacroM Command :=
  `(command| set_option match.ignoreUnusedAlts true in $command:command)

/-- The cases as constructors of the type named `self`. -/
private def casesOf (self : Ident) (cases : Array (TSyntax ``caseOf)) :
    MacroM (Array (TSyntax ``Command.ctor) × Array Ident) := do
  let mut ctors := #[]
  let mut names := #[]
  for case in cases do
    match case with
    | `(caseOf| | $name:ident $binders*) =>
      let mut types : Array Term := #[]
      for binder in binders do
        match binder with
        | `(callBinder| ($ids* : $type)) => types := types ++ ids.map fun _ => type
        | _ => Macro.throwUnsupported
      let type ← types.foldrM (fun type rest => `($type → $rest)) (← `($self))
      ctors := ctors.push (← `(Command.ctor| | $name:ident : $type))
      names := names.push name
    | _ => Macro.throwUnsupported
  return (ctors, names)

private def altsOf (alts : Array (TSyntax ``modelAlt)) : MacroM (Array (TSyntax ``Term.matchAlt)) := do
  let alts ← alts.mapM fun alt =>
    match alt with
    | `(modelAlt| | $patterns,* => $result) => `(Term.matchAltExpr| | $patterns,* => $result)
    | _ => Macro.throwUnsupported
  return alts.map fun alt => ⟨alt.raw⟩

macro_rules
  | `(aggregate $a:ident where $items*) => do
    let n (name : Name) : Ident := mkIdentFrom a name
    let mut commands : Array Command := #[← `(command| namespace $a)]
    let mut hasReply := false
    let mut checks : Array Command := #[]
    -- Who sends the commands, if the aggregate says.
    let mut actor : Option Term := none
    for item in items do
      if let `(aggregateItem| actor : $type:term) := item then actor := some type
    let actorType : Term ← match actor with
      | some type => pure type
      | none => `(Unit)
    commands := commands.push (← `(command| abbrev $(n `Actor) : Type := $actorType))
    -- `decide` takes the actor first when there is one.
    let decideCall : Term ← match actor with
      | some _ => `($(n `decide) actor)
      | none => `($(n `decide))
    for item in items do
      match item with
      | `(aggregateItem| actor : $_) => pure ()
      | `(aggregateItem| command $cases*) =>
        let mut plain : Array (TSyntax ``caseOf) := #[]
        for case in cases do
          match case with
          | `(commandOf| | $name:ident $binders* $[records $events,*]? $[rejects $rejections,*]?) =>
            plain := plain.push (← `(caseOf| | $name:ident $binders*))
            let mut arguments : Array Ident := #[]
            let mut bracketed := #[]
            for binder in binders do
              match binder with
              | `(callBinder| ($ids* : $type)) =>
                arguments := arguments ++ ids
                bracketed := bracketed.push (← `(bracketedBinder| ($ids* : $type)))
              | _ => Macro.throwUnsupported
            let sent ← `($(mkIdentFrom name (`Command ++ name.getId)):ident $arguments*)
            if let some events := events then
              let allowed ← events.getElems.mapM fun event =>
                `(Term.matchAltExpr| | $(mkIdentFrom event (`Event ++ event.getId)):ident .. => True)
              let allowed : Array (TSyntax ``Term.matchAlt) :=
                (allowed.push (← `(Term.matchAltExpr| | _ => False))).map fun alt => ⟨alt.raw⟩
              checks := checks.push (← withRef name <| do lenient (← `(command|
                /-- The command records only the events it says it records. -/
                theorem $(mkIdentFrom name (`records ++ name.getId)):ident
                    (actor : $(n `Actor)) (state : $(n `State)) $bracketed* (events : List $(n `Event))
                    (accepted : $decideCall state $sent = .ok events) :
                    ∀ event ∈ events, (match event with $allowed:matchAlt*) := by
                  simp only [$(n `decide):ident] at accepted
                  (repeat' split at accepted) <;>
                    first | (simp_all; done) | (cases accepted <;> simp_all; done) | (cases accepted <;> simp; done) | grind | fail "this command can record an event that its records line does not list")))
            if let some rejections := rejections then
              let allowed ← rejections.getElems.mapM fun rejection =>
                `(Term.matchAltExpr|
                  | $(mkIdentFrom rejection (`Rejection ++ rejection.getId)):ident .. => True)
              let allowed : Array (TSyntax ``Term.matchAlt) :=
                (allowed.push (← `(Term.matchAltExpr| | _ => False))).map fun alt => ⟨alt.raw⟩
              checks := checks.push (← withRef name <| do lenient (← `(command|
                /-- The command answers only the rejections it says it answers. -/
                theorem $(mkIdentFrom name (`rejects ++ name.getId)):ident
                    (actor : $(n `Actor)) (state : $(n `State)) $bracketed* (rejection : $(n `Rejection))
                    (rejected : $decideCall state $sent = .error rejection) :
                    (match rejection with $allowed:matchAlt*) := by
                  simp only [$(n `decide):ident] at rejected
                  (repeat' split at rejected) <;>
                    first | (simp_all; done) | (cases rejected <;> simp_all; done) | (cases rejected <;> simp; done) | grind | fail "this command can be refused with a rejection that its rejects line does not list")))
          | _ => Macro.throwUnsupported
        let (ctors, names) ← casesOf (n `Command) plain
        commands := commands.push (← `(command|
          inductive $(n `Command) where $ctors*
            deriving DecidableEq, Repr, Lean.ToJson, Lean.FromJson))
        commands := commands.push (← `(command| derive_tokens $(n `Command)))
        let keyAlts ← names.mapM fun name => do
          let ctorName := mkIdentFrom name (`Command ++ name.getId)
          `(Term.matchAltExpr| | $ctorName:ident id .. => id)
        let keyAlts : Array (TSyntax ``Term.matchAlt) := keyAlts.map fun alt => ⟨alt.raw⟩
        commands := commands.push (← `(command|
          /-- The instance a command is for: its first field. -/
          def $(n `key) (command : $(n `Command)) : String := match command with $keyAlts:matchAlt*))
      | `(aggregateItem| event $cases*) =>
        let (ctors, _) ← casesOf (n `Event) cases
        commands := commands.push (← `(command|
          inductive $(n `Event) where $ctors* deriving DecidableEq, Repr))
      | `(aggregateItem| rejection $cases*) =>
        let (ctors, _) ← casesOf (n `Rejection) cases
        commands := commands.push (← `(command|
          inductive $(n `Rejection) where $ctors* deriving DecidableEq, Repr))
      | `(aggregateItem| state $fields*) =>
        let mut ids : Array Ident := #[]
        let mut types : Array Term := #[]
        let mut starts : Array Term := #[]
        for field in fields do
          match field with
          | `(fieldOf| $id:ident : $type := $start) =>
            ids := ids.push id; types := types.push type; starts := starts.push start
          | _ => Macro.throwUnsupported
        commands := commands.push (← `(command|
          structure $(n `State) where
            $[$ids:ident : $types := $starts]*
          deriving DecidableEq, Repr))
      | `(aggregateItem| decide $alts:modelAlt*) =>
        let alts ← altsOf alts
        match actor with
        | some _ =>
          commands := commands.push (← `(command|
            /-- The events a command records, or why it is refused, given who sends it. -/
            def $(n `decide) (actor : $(n `Actor)) (state : $(n `State)) (command : $(n `Command)) :
                Except $(n `Rejection) (List $(n `Event)) :=
              match actor, state, command with $alts:matchAlt*))
        | none =>
          commands := commands.push (← `(command|
            /-- The events a command records, or why it is refused. -/
            def $(n `decide) (state : $(n `State)) (command : $(n `Command)) :
                Except $(n `Rejection) (List $(n `Event)) :=
              match state, command with $alts:matchAlt*))
      | `(aggregateItem| evolve $alts:modelAlt*) =>
        let alts ← altsOf alts
        commands := commands.push (← `(command|
          /-- What an event does to the state. -/
          def $(n `evolve) (state : $(n `State)) (event : $(n `Event)) : $(n `State) :=
            match state, event with $alts:matchAlt*))
      | `(aggregateItem| reply : $type:term $alts:modelAlt*) =>
        hasReply := true
        let alts ← altsOf alts
        commands := commands.push (← `(command| abbrev $(n `Reply) : Type := $type))
        commands := commands.push (← `(command|
          /-- What an accepted command answers its caller, from the state it left. -/
          def $(n `reply) (state : $(n `State)) (command : $(n `Command)) : $(n `Reply) :=
            match state, command with $alts:matchAlt*))
      | _ => Macro.throwUnsupported
    unless hasReply do
      commands := commands.push (← `(command| abbrev $(n `Reply) : Type := Unit))
      commands := commands.push (← `(command|
        def $(n `reply) (_ : $(n `State)) (_ : $(n `Command)) : $(n `Reply) := ()))
    commands := commands ++ checks
    let decideField : Term ← match actor with
      | some _ => `(fun ctx state command => $(mkIdentFrom a (`_root_ ++ a.getId ++ `decide)) ctx.actor state command)
      | none => `(fun _ state command => $(mkIdentFrom a (`_root_ ++ a.getId ++ `decide)) state command)
    let r (name : Name) : Ident := mkIdentFrom a (`_root_ ++ a.getId ++ name)
    commands := commands.push (← `(command| end $a))
    commands := commands.push (← `(command|
      /-- The aggregate: its types and functions, tied together. -/
      abbrev $a:ident : Alchemy.Aggregate where
        name := $(Syntax.mkStrLit (toString a.getId))
        Id := String
        State := $(r `State)
        Command := $(r `Command)
        Event := $(r `Event)
        Rejection := $(r `Rejection)
        Actor := $(r `Actor)
        initial := {}
        keyOf := $(r `key)
        decide := $decideField
        evolve := fun state event _ => $(r `evolve) state event
        Reply := $(r `Reply)
        reply := $(r `reply)))
    return mkNullNode commands

/-- An aggregate, by the namespace that defines it. -/
syntax &"aggregate " ident : modelItem
/-- A call to a system outside the model, and what it answers. -/
syntax &"call " ident callBinder* " : " term : modelItem
/-- What to do whenever an aggregate records an event: `| id, event => …`. -/
syntax &"policy " ident &" on " ident modelAlt+ : modelItem
/-- A value folded over an aggregate's events: `| value, event => …`. -/
syntax &"view " ident &" on " ident " : " term " := " term modelAlt+ : modelItem
/-- A value for each instance of an aggregate, folded over that instance's events. -/
syntax &"view " ident &" on " ident &" by " &"id" " : " term " := " term modelAlt+ : modelItem
/-- Rows written for an aggregate's events: `| id, event => […]`. -/
syntax &"projection " ident &" on " ident " : " term modelAlt+ : modelItem

/-- An ordered log for each instance of an aggregate, that readers follow: `| id, event => […]`. -/
syntax &"stream " ident &" on " ident " : " term modelAlt+ : modelItem
/-- A question answered from everything recorded: `| log, input => rows`. -/
syntax &"query " ident "(" term ")" " : " term modelAlt+ : modelItem
/--
A command decided across several instances at once: `| states, command => …`
answers the events to record on each, or a rejection.
-/
syntax &"decision " ident "(" term ")" " : " term modelAlt+ : modelItem
/--
A process with several steps, started by a policy: `| id, input => …`. It is
given what it is started with, may be told a signal while it waits, and may fail.
-/
syntax &"saga " ident "(" term ")" "(" term ")" " : " term modelAlt+ : modelItem

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

/-- The cases of a block as `match` alternatives, as written. -/
private def exactly (alts : Array (TSyntax ``modelAlt)) : MacroM (Array (TSyntax ``Term.matchAlt)) := do
  let alts ← alts.mapM fun alt =>
    match alt with
    | `(modelAlt| | $patterns,* => $result) => `(Term.matchAltExpr| | $patterns,* => $result)
    | _ => Macro.throwUnsupported
  return alts.map fun alt => ⟨alt.raw⟩

macro_rules
  | `(model $m:ident where $items*) => do
    let mut aggregates : Array Ident := #[]
    let mut callCtors := #[]
    let mut replyAlts := #[]
    let mut callDefs : Array Command := #[]
    let mut callNames : Array Ident := #[]
    let mut later : Array Command := #[]
    let mut policies : Array Ident := #[]
    let mut views : Array Ident := #[]
    let mut projections : Array Ident := #[]
    let mut decisions : Array Ident := #[]
    let mut streams : Array Ident := #[]
    let mut queries : Array Ident := #[]
    let mut decisionCommands : Array Term := #[]
    -- Each saga: its name, what a run is started with, what it can be told, and how it can fail.
    let mut sagas : Array (Ident × Term × Term × Term) := #[]
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
        callNames := callNames.push c
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
      | `(modelItem| view $v:ident on $a:ident by id : $type := $initial:term $alts:modelAlt*) =>
        views := views.push v
        let step := under v `step
        let keyOf := under v `key
        let alts ← withFallback alts (← `(Term.matchAltExpr| | state, _ => state))
        later := later.push (← lenient <| ← `(command|
          def $step:ident (state : $type) : Alchemy.Emitted $aggregatesId → $type
            | ⟨$(under name a.getId), _, event, _, _⟩ =>
              match state, (event : $(rooted a `Event)) with $alts:matchAlt*
            | _ => state))
        later := later.push (← lenient <| ← `(command|
          /-- The instance an event is about, if it is one of this aggregate's. -/
          def $keyOf:ident : Alchemy.Emitted $aggregatesId → Option String
            | ⟨$(under name a.getId), id, _, _, _⟩ => some id
            | _ => none))
        later := later.push (← `(command|
          abbrev $v:ident : Alchemy.View $aggregatesId :=
            Alchemy.View.keyed $(text v) $initial $keyOf $step))
        later := later.push (← `(command|
          /-- The view at an instance is exactly its step folded over that instance's events. -/
          theorem $(under v `exact):ident (log : List (Alchemy.Emitted $aggregatesId)) (id : String) :
              Alchemy.View.stateAt $v log id
                = log.foldl (fun state event => if $keyOf event = some id then $step state event
                    else state) $initial :=
            Alchemy.View.keyed_exact _ _ _ _ log id))
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
      | `(modelItem| stream $v:ident on $a:ident : $entry:term $alts:modelAlt*) =>
        streams := streams.push v
        let entries := under v `appended
        let alts ← withFallback alts (← `(Term.matchAltExpr| | _, _ => []))
        later := later.push (← lenient <| ← `(command|
          def $entries:ident : Alchemy.Emitted $aggregatesId → List (String × $entry)
            | ⟨$(under name a.getId), id, event, _, _⟩ =>
              (match (id : String), (event : $(rooted a `Event)) with $alts:matchAlt*).map
                fun entry => (id, entry)
            | _ => []))
        later := later.push (← `(command|
          abbrev $v:ident : Alchemy.Stream $aggregatesId := Alchemy.Stream.each $(text v) $entries))
        later := later.push (← `(command|
          /-- The stream at an instance holds exactly the entries its events gave it, in order. -/
          theorem $(under v `exact):ident (log : List (Alchemy.Emitted $aggregatesId)) (id : String) :
              Alchemy.Stream.entries $v log id
                = (log.flatMap $entries).filterMap fun (k, entry) => if k = id then some entry else none :=
            Alchemy.Stream.each_exact _ _ log id))
      | `(modelItem| query $v:ident ($input:term) : $row:term $alts:modelAlt*) =>
        queries := queries.push v
        let rows := under v `rows
        let alts ← exactly alts
        later := later.push (← `(command|
          def $rows:ident (log : List (Alchemy.Emitted $aggregatesId)) (input : $input) : List $row :=
            match log, input with $alts:matchAlt*))
        later := later.push (← `(command|
          abbrev $v:ident : Alchemy.Query $aggregatesId where
            name := $(text v)
            Input := $input
            Row := $row
            Actor := Unit
            Rejection := Empty
            handle := fun _ log input => .ok ($rows log input)))
      | `(modelItem| decision $d:ident ($command:term) : $rejection:term $alts:modelAlt*) =>
        decisions := decisions.push d
        decisionCommands := decisionCommands.push command
        let run := under d `decide
        let alts ← exactly alts
        later := later.push (← `(command|
          def $run:ident (states : Alchemy.States $aggregatesId) (command : $command) :
              Except $rejection (List (Alchemy.Record $aggregatesId)) :=
            match states, command with $alts:matchAlt*))
        later := later.push (← `(command|
          abbrev $d:ident : Alchemy.Decision $aggregatesId where
            name := $(text d)
            Command := $command
            Rejection := $rejection
            Actor := Unit
            decide := fun _ states command => $run states command))
      | `(modelItem| saga $g:ident ($input:term) ($signal:term) : $failure:term $alts:modelAlt*) =>
        sagas := sagas.push (g, input, signal, failure)
        let alts ← exactly alts
        later := later.push (← `(command|
          /-- The saga's steps, for one run. -/
          def $(under g `run):ident (id : String) (input : $input) :
              Alchemy.Program $signature Unit :=
            match id, input with $alts:matchAlt*))
      | _ => Macro.throwUnsupported
    let mut commands : Array Command := #[]
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
    if replyAlts.isEmpty then
      commands := commands.push (← `(command|
        abbrev $(mkIdent `Reply) : $callId → Type := fun c => nomatch c))
    else
      commands := commands.push (← `(command|
        abbrev $(mkIdent `Reply) : $callId → Type := fun c => match c with $replyAlts:matchAlt*))
    -- One saga: its own types. Several: a run is named by its saga, and each type is one of theirs.
    let several := sagas.size > 1
    let sagaNames := mkIdent `Sagas
    let sumInput := mkIdent `SagaInput
    let sumSignal := mkIdent `SagaSignal
    let sumFailure := mkIdent `SagaFailure
    let mut sagaKey : Term ← `(String)
    let mut sagaInput : Term ← `(Unit)
    let mut sagaSignal : Term ← `(Unit)
    let mut sagaFailure : Term ← `(Unit)
    if several then
      let names ← sagas.mapM fun (g, _, _, _) => `(Command.ctor| | $g:ident)
      let inputs ← sagas.mapM fun (g, input, _, _) => `(Command.ctor| | $g:ident (input : $input))
      let signals ← sagas.mapM fun (g, _, signal, _) => `(Command.ctor| | $g:ident (signal : $signal))
      let failures ← sagas.mapM fun (g, _, _, failure) => `(Command.ctor| | $g:ident (failure : $failure))
      commands := commands.push (← `(command|
        /-- The sagas of the model. -/
        inductive $sagaNames where $names* deriving DecidableEq, Repr))
      commands := commands.push (← `(command|
        /-- What a run is started with: one saga's input. -/
        inductive $sumInput where $inputs*))
      commands := commands.push (← `(command|
        /-- What a run can be told while it waits: one saga's signal. -/
        inductive $sumSignal where $signals*))
      commands := commands.push (← `(command|
        /-- How a run can fail: one saga's failure. -/
        inductive $sumFailure where $failures* deriving DecidableEq, Repr))
      sagaKey ← `($sagaNames × String)
      sagaInput ← `($sumInput)
      sagaSignal ← `($sumSignal)
      sagaFailure ← `($sumFailure)
    else if let some (_, input, signal, failure) := sagas[0]? then
      sagaInput := input
      sagaSignal := signal
      sagaFailure := failure
    commands := commands.push (← `(command|
      abbrev $signature : Alchemy.Signature where
        aggregates := $aggregatesId
        Call := $callId
        Reply := $(mkIdent `Reply)
        Saga := $sagaKey
        SagaInput := $sagaInput
        Signal := $sagaSignal
        Failure := $sagaFailure))
    for (g, input, signal, failure) in sagas do
      if several then
        commands := commands.push (← `(command|
          /-- Start a run of the saga, from a policy. A run already started is left alone. -/
          def $(under g `start):ident (id : String) (input : $input) : Alchemy.Program $signature Unit :=
            Alchemy.Program.startSaga (σ := $signature) ($(under sagaNames g.getId), id)
              ($(under sumInput g.getId) input)))
        commands := commands.push (← `(command|
          /-- Tell a run of the saga something, from a policy. -/
          def $(under g `signal):ident (id : String) (signal : $signal) : Alchemy.Program $signature Unit :=
            Alchemy.Program.signalSaga (σ := $signature) ($(under sagaNames g.getId), id)
              ($(under sumSignal g.getId) signal)))
        commands := commands.push (← `(command|
          /-- This saga's failure, as a failure of the model. -/
          abbrev $(under g `failure):ident (failure : $failure) : $sumFailure :=
            $(under sumFailure g.getId) failure))
        commands := commands.push (← `(command|
          /-- Stop this saga: what it registered to undo is undone, newest first. -/
          def $(under g `failWith):ident {α : Type} (failure : $failure) : Alchemy.Program $signature α :=
            Alchemy.Program.fail ($(under sumFailure g.getId) failure)))
        commands := commands.push (← `(command|
          /-- Wait for the next signal sent to this run. `none` if it was meant for another saga. -/
          def $(under g `awaitSignal):ident : Alchemy.Program $signature (Option $signal) :=
            Alchemy.Program.await (σ := $signature) fun told =>
              match told with
              | $(under sumSignal g.getId):ident signal => Alchemy.Program.pure (some signal)
              | _ => Alchemy.Program.pure none))
        for a in aggregates do
          commands := commands.push (← `(command|
            /-- Send the aggregate a command; a rejection fails this saga with what `explain` makes of it. -/
            def $(mkIdentFrom g (g.getId ++ a.getId ++ `must)):ident (command : $(rooted a `Command))
                (explain : $(rooted a `Rejection) → $failure)
                (actor : $(rooted a `Actor) := by exact default) : Alchemy.Program $signature Unit :=
              Alchemy.Program.step ⟨$(under name a.getId), actor, command⟩
                fun rejection => $(under sumFailure g.getId) (explain rejection)))
      else
        commands := commands.push (← `(command|
          /-- Start a run of the saga, from a policy. A run already started is left alone. -/
          def $(under g `start):ident (id : String) (input : $input) : Alchemy.Program $signature Unit :=
            Alchemy.Program.startSaga (σ := $signature) id input))
        commands := commands.push (← `(command|
          /-- Tell a run of the saga something, from a policy. -/
          def $(under g `signal):ident (id : String) (signal : $signal) : Alchemy.Program $signature Unit :=
            Alchemy.Program.signalSaga (σ := $signature) id signal))
    commands := commands.push (← `(command|
      /-- Wait for the next signal sent to this run of the saga. -/
      def $(mkIdent `awaitSignal) : Alchemy.Program $signature $sagaSignal :=
        Alchemy.Program.awaitSignal (σ := $signature)))
    commands := commands.push (← `(command|
      /-- Stop the saga: what it registered to undo is undone, newest first. -/
      def $(mkIdent `failWith) {α : Type} (failure : $sagaFailure) : Alchemy.Program $signature α :=
        Alchemy.Program.fail failure))
    commands := commands ++ callDefs
    for a in aggregates do
      commands := commands.push (← `(command|
        /-- Send this aggregate a command, from a policy. -/
        def $(under a `send):ident (command : $(rooted a `Command))
            (actor : $(rooted a `Actor) := by exact default) : Alchemy.Program $signature Unit :=
          Alchemy.Program.tell ⟨$(under name a.getId), actor, command⟩))
      commands := commands.push (← `(command|
        /-- Send this aggregate a command; a rejection fails the saga with what `explain` makes of it. -/
        def $(under a `must):ident (command : $(rooted a `Command))
            (explain : $(rooted a `Rejection) → $sagaFailure)
            (actor : $(rooted a `Actor) := by exact default) : Alchemy.Program $signature Unit :=
          Alchemy.Program.step ⟨$(under name a.getId), actor, command⟩ explain))
      commands := commands.push (← `(command|
        /-- From here on, if the saga fails, send this aggregate this command. -/
        def $(under a `undoWith):ident (command : $(rooted a `Command))
            (actor : $(rooted a `Actor) := by exact default) : Alchemy.Program $signature Unit :=
          Alchemy.Program.undoWith fun _ => ⟨$(under name a.getId), actor, command⟩))
      commands := commands.push (← `(command|
        /-- An event to record on an instance of this aggregate, in a decision. -/
        def $(under a `record):ident (id : String) (event : $(rooted a `Event)) :
            Alchemy.Record $aggregatesId :=
          ⟨$(under name a.getId), id, event⟩))
      commands := commands.push (← `(command|
        /-- The state of an instance of this aggregate, in a decision. -/
        def $(under a `of):ident (states : Alchemy.States $aggregatesId) (id : String) :
            $(rooted a `State) :=
          states $(under name a.getId) id))
    commands := commands ++ later
    commands := commands.push (← `(command| end $m))
    let sagaRun : Term ← if several then do
        let runs ← sagas.mapM fun (g, _, _, _) =>
          `(Term.matchAltExpr|
            | ($(under (under m `Sagas) g.getId):ident, id), $(under (under m `SagaInput) g.getId):ident input =>
              $(under m (g.getId ++ `run)) id input)
        let runs : Array (TSyntax ``Term.matchAlt) :=
          (runs.push (← `(Term.matchAltExpr| | _, _ => Alchemy.Program.pure ()))).map fun alt => ⟨alt.raw⟩
        `(fun key input => match key, input with $runs:matchAlt*)
      else match sagas[0]? with
        | some (g, _, _, _) => `($(under m (g.getId ++ `run)))
        | none => `(fun _ _ => Alchemy.Program.pure ())
    commands := commands.push (← `(command|
      abbrev $m:ident : Alchemy.Model where
        name := $(text m)
        signature := $(under m `Signature)
        decisions := [$[$(decisions.map (under m ·.getId))],*]
        policies := [$[$(policies.map (under m ·.getId))],*]
        views := [$[$(views.map (under m ·.getId))],*]
        projections := [$[$(projections.map (under m ·.getId))],*]
        streams := [$[$(streams.map (under m ·.getId))],*]
        queries := [$[$(queries.map (under m ·.getId))],*]
        saga := $sagaRun))
    -- What callers send, how the model is served, and each aggregate's rules lifted to the model.
    commands := commands.push (← `(command| namespace $m))
    let input := mkIdent `Input
    let inputCtors ← aggregates.mapM fun a =>
      `(Command.ctor| | $a:ident (command : $(rooted a `Command))
          (actor : $(rooted a `Actor) := by exact default))
    commands := commands.push (← `(command|
      /-- What callers send: a command for one of the aggregates. -/
      inductive $input where $inputCtors*))
    commands := commands.push (← `(command| derive_tokens $input))
    let commandAlts ← aggregates.mapM fun a =>
      `(Term.matchAltExpr| | $(under input a.getId):ident command actor =>
          ⟨$(under name a.getId), actor, command⟩)
    let served := mkIdent `served
    if decisions.isEmpty then
      commands := commands.push (← `(command|
        /-- How the model is spoken to: callers send commands, and its history is written as JSON. -/
        abbrev $served : Alchemy.Cloud.Served $(rooted m) where
          Input := $input
          command := fun input => match input with $commandAlts:matchAlt*))
    else
      let deciding := mkIdent `Deciding
      let decidingCtors ← (decisions.zip decisionCommands).mapM fun (d, command) =>
        `(Command.ctor| | $d:ident (command : $command))
      commands := commands.push (← `(command|
        /-- What callers send that is decided across instances. -/
        inductive $deciding where $decidingCtors*))
      commands := commands.push (← `(command| derive_tokens $deciding))
      let decisionAlts ← decisions.mapM fun d =>
        `(Term.matchAltExpr| | $(under deciding d.getId):ident command =>
            ⟨$(under m d.getId), ⟨by repeat (first | exact List.Mem.head _ | apply List.Mem.tail)⟩,
              (), command⟩)
      let decisionAlts : Array (TSyntax ``Term.matchAlt) := decisionAlts.map fun alt => ⟨alt.raw⟩
      commands := commands.push (← `(command|
        /--
        How the model is spoken to: callers send commands and ask for decisions,
        and its history is written as JSON.
        -/
        abbrev $served : Alchemy.Cloud.Served $(rooted m) where
          Input := $input
          command := fun input => match input with $commandAlts:matchAlt*
          Deciding := $deciding
          decision := fun input => match input with $decisionAlts:matchAlt*))
    for a in aggregates do
      let always := mkIdent (a.getId ++ `always)
      let here := under name a.getId
      commands := commands.push (← `(command|
        /--
        A rule the aggregate keeps holds of every instance, in every world the
        model can reach. With decisions in the model, they must keep it too.
        -/
        theorem $always {P : $(rooted a `State) → Prop}
            (initially : P (Alchemy.Aggregate.initial $(rooted a)))
            (kept : Alchemy.Aggregate.Keeps $(rooted a) P)
            (w : Alchemy.World $signature) (reach : Alchemy.Model.Reachable $(rooted m) w)
            (id : String)
            (decided : ∀ d ∈ Alchemy.Model.decisions $(rooted m),
              ∀ (r : Alchemy.Recorded $aggregatesId) (ctx : Alchemy.Context d.Actor) c,
                (∀ id, P (r.state $here id)) → ∀ id, P ((r.decide d ctx c).state $here id) := by
              intro d mem; cases mem) :
            P (w.state $here id) :=
          Alchemy.Model.alwaysAtWith $(rooted m) $here P initially kept decided w reach id))
      commands := commands.push (← `(command|
        /-- And of the model as deployed, whatever its journal holds. -/
        theorem $(mkIdent (a.getId ++ `deployed)) {P : $(rooted a `State) → Prop}
            (initially : P (Alchemy.Aggregate.initial $(rooted a)))
            (kept : Alchemy.Aggregate.Keeps $(rooted a) P)
            (journal : List Alchemy.Cloud.Journal.Line) (id : String)
            (decided : ∀ d ∈ Alchemy.Model.decisions $(rooted m),
              ∀ (r : Alchemy.Recorded $aggregatesId) (ctx : Alchemy.Context d.Actor) c,
                (∀ id, P (r.state $here id)) → ∀ id, P ((r.decide d ctx c).state $here id) := by
              intro d mem; cases mem) :
            P ((Alchemy.Cloud.Served.replay $served journal).state $here id) :=
          $always initially kept _ (Alchemy.Cloud.Served.replay_reachable $served journal) id decided))
    commands := commands.push (← `(command| end $m))
    -- What a behaviour proof steps through: the model's own definitions.
    let mut stepped : Array Ident := #[]
    for a in aggregates do
      stepped := stepped ++ #[rooted a `decide, rooted a `evolve, rooted a `key, rooted a `reply]
      for helper in [`send, `must, `undoWith, `record, `of] do
        stepped := stepped.push (under m (a.getId ++ helper))
    for p in policies do stepped := stepped.push (under m p.getId)
    for d in decisions do stepped := stepped.push (under m (d.getId ++ `decide))
    for c in callNames do stepped := stepped.push (under m c.getId)
    for (g, _, _, _) in sagas do
      for helper in (if several then [`run, `start, `signal, `failWith] else [`run, `start, `signal]) do
        stepped := stepped.push (under m (g.getId ++ helper))
      if several then
        stepped := stepped.push (under m (g.getId ++ `awaitSignal))
        for a in aggregates do stepped := stepped.push (under m (g.getId ++ a.getId ++ `must))
    stepped := stepped ++ #[under m `awaitSignal, under m `failWith]
    commands := commands.push (← `(command| attribute [behaviour] $stepped*))
    return mkNullNode commands

end Alchemy
