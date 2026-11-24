import Lean
import Alchemy.Rest
import Alchemy.Behaviour

/-!
# Coming to rest, found by the checker

`comes_to_rest Bank` finds what each event, each command and each saga of a
model weighs, and proves with those weights that the model comes to rest. The
weights are searched for: nobody writes a table.
-/

namespace Alchemy

open Lean Elab Tactic Meta

/--
The least number an attempt works for, given that nothing below `start` does:
stepped up from there until one works, then closed in on.
-/
def leastWorking (what : String) (start : Nat) (attempt : Nat → TacticM Unit) (limit : Nat := 4096) :
    TacticM Unit := do
  let works (k : Nat) : TacticM Bool := do
    let saved ← saveState
    let ok ← try attempt k; pure true catch _ => pure false
    saved.restore
    pure ok
  if ← works start then
    attempt start
    return
  let mut low := start
  let mut step := 1
  let mut high := start + 1
  while !(← works high) do
    if high ≥ limit then
      -- Run it once more, so the reason it fails is the error shown.
      attempt high
      throwError "no {what} up to {limit} is enough"
    low := high
    step := step * 2
    high := high + step
  while low + 1 < high do
    let middle := (low + high) / 2
    if ← works middle then high := middle else low := middle
  attempt high

/-- Closes a goal `{ n // P n }` with the least `n`, from the one given, the tactics prove `P n` for. -/
syntax "least_such " "from " num tacticSeq : tactic

elab_rules : tactic
  | `(tactic| least_such from $start $tactics) =>
    leastWorking "number" start.getNat fun k => do
      evalTactic (← `(tactic| (refine ⟨$(quote k), ?_⟩; ($tactics); done)))

/--
Gives a program the least rank it has: the goal's rank is left open and filled
in. The rank given is tried first. If it is not enough the program is measured:
walked once with more rank than it could need, to see how much is left over.
-/
syntax "ranked_least " "from " num ident " [" term,* "]" : tactic

elab_rules : tactic
  | `(tactic| ranked_least from $start $ranking [$sagas,*]) => do
    -- Open the program up once, so every `if` in it is in sight.
    evalTactic (← `(tactic| try simp only [behaviour]))
    let attempt (k : Nat) : TacticM Unit := do
      evalTactic (← `(tactic| focus (
        refine Alchemy.Model.Ranked.mono (a := $(quote k)) ?_ (Nat.le_refl _)
        ranked $ranking [$sagas,*]
        done)))
    let saved ← saveState
    try
      attempt start.getNat
    catch _ =>
      saved.restore
      let plenty := 1 <<< 40
      rankLeft.set plenty
      attempt plenty
      let left ← rankLeft.get
      saved.restore
      attempt (plenty - left + 1)

/-- Ranks each reaction to one event, each with the least rank it has. -/
syntax "reaction_ranks " ident " [" term,* "]" : tactic

macro_rules
  | `(tactic| reaction_ranks $ranking [$sagas,*]) =>
    `(tactic| focus (
      (repeat' first
        | exact Alchemy.Model.Ranking.programs.nil
        | (apply Alchemy.Model.Ranking.programs.cons
           focus (ranked_least from 0 $ranking [$sagas,*])))
      done))

/-- Proves that an event outweighs the reactions to it: `reactions Bank.ranking [Bank.rank_Payout]`. -/
syntax "reactions " ident " [" term,* "]" : tactic

macro_rules
  | `(tactic| reactions $ranking [$sagas,*]) =>
    `(tactic| (
      apply Alchemy.Model.Ranking.reacting
      reaction_ranks $ranking [$sagas,*]
      ranked_fits $ranking))

/-- The same, with each reaction's rank given. -/
syntax "reactions_ranked " ident " [" term,* "]" " [" num,* "]" : tactic

macro_rules
  | `(tactic| reactions_ranked $ranking [$sagas,*] [$ranks,*]) =>
    `(tactic| (
      refine Alchemy.Model.Ranking.reacting _ (ranks := [$ranks,*]) ?_ ?_
      focus (
        (repeat' first
          | exact Alchemy.Model.Ranking.programs.nil
          | (apply Alchemy.Model.Ranking.programs.cons
             focus (try simp only [behaviour]
                    ranked $ranking [$sagas,*]
                    done)))
        done)
      ranked_fits $ranking))

/-- Settles one accepted command: what it records weighs no more than the bound. -/
syntax "records_fit " ident " [" ident,* "]" : tactic

macro_rules
  | `(tactic| records_fit $accepted [$unfold,*]) =>
    `(tactic| (
      simp only [$[$unfold:ident],*] at $accepted:ident <;> (repeat' split at $accepted:ident) <;>
        first
          | (cases $accepted:ident; first | decide | (simp; done) | (simp; omega))
          | (cases $accepted:ident; done)))

open Command Term

/-- The constructors of the type a term stands for, each with how many fields it takes. -/
private def constructorsOf (type : Term) : CommandElabM (Array (Name × Nat)) :=
  liftTermElabM do
    let e ← whnf (← elabType type)
    let .const name _ := e.getAppFn
      | throwError "{type} is not a type with cases"
    let info ← getConstInfoInduct name
    info.ctors.toArray.mapM fun c => do return (c, (← getConstInfoCtor c).numFields)

/-- Names for a constructor's fields. -/
private def fields (count : Nat) : Array Ident :=
  (Array.range count).map fun i => mkIdent (Name.mkSimple s!"x{i}")

/-- Check some commands, run what needs them, and keep nothing. -/
private def scratch {α : Type} (commands : Array Syntax) (go : CommandElabM α) : CommandElabM α := do
  let saved ← get
  try
    for c in commands do elabCommand c
    if (← get).messages.hasErrors then
      let texts ← (← get).messages.toList.filterMapM fun m =>
        if m.severity == .error then some <$> m.data.toString else pure none
      throwError "could not set up the search:\n{"\n".intercalate texts}"
    go
  finally
    set saved

/-- The number a search found: the first part of the pair the term builds. -/
private def found (term : Term) : CommandElabM Nat :=
  liftTermElabM <| withoutErrToSorry do
    let e ← elabTerm term none
    synthesizeSyntheticMVarsNoPostponing
    let e ← whnf (← instantiateMVars e)
    let some value := e.getAppArgs[2]?
      | throwError "the search did not end with a number"
    let value ← instantiateMVars value
    match ← (evalNat value).run with
    | some n => return n
    | none =>
      let .lit (.natVal n) ← whnf value | throwError "the search ended with {value}, not a number"
      return n

/--
`comes_to_rest Bank` finds the weights and proves:

* `Bank.ranking`: what each event, command and saga weighs;
* `Bank.reacts`: every event outweighs the reactions to it;
* `Bank.comesToRest`: from any world the model can reach, it stops.
-/
syntax (name := comesToRest) "comes_to_rest " ident : command

@[command_elab comesToRest] def elabComesToRest : CommandElab := fun stx => do
  let `(comes_to_rest $model) := stx | throwUnsupportedSyntax
  let m ← liftCoreM <| realizeGlobalConstNoOverloadWithInfo model
  let at_ (n : Name) : Ident := mkIdent (`_root_ ++ m ++ n)
  let M : Ident := mkIdent (`_root_ ++ m)
  let ranking := at_ `ranking
  let eventWeight := at_ `eventWeight
  let sendWeight := at_ `sendWeight
  let names ← constructorsOf (← `(($M).signature.aggregates.Name))
  -- Every event and every command of every aggregate.
  let mut events : Array (Name × Name × Nat) := #[]
  let mut commands : Array (Name × Name × Nat) := #[]
  let mut decides : Array Ident := #[]
  for (a, _) in names do
    let A := mkIdent a
    for (c, k) in ← constructorsOf (← `((($M).signature.aggregates.of $A).Event)) do
      events := events.push (a, c, k)
      if c.getPrefix.getPrefix ++ `decide ∉ decides.map (·.getId) then
        decides := decides.push (mkIdent (c.getPrefix.getPrefix ++ `decide))
    for (c, k) in ← constructorsOf (← `((($M).signature.aggregates.of $A).Command)) do
      commands := commands.push (a, c, k)
  -- The sagas: several are named, one is the model's own.
  let env ← getEnv
  let sagas : Array (Option Name) :=
    match env.find? (m ++ `Sagas) with
    | some (.inductInfo info) => info.ctors.toArray.map some
    | _ => #[none]
  let sagaRank (s : Option Name) : Ident :=
    match s with
    | some s => at_ (Name.mkSimple s!"rank_{s.getString!}")
    | none => at_ `rank_saga
  let sagaRun (s : Option Name) : CommandElabM Term :=
    match s with
    | some s =>
      `(($M).saga ($(mkIdent s), id) ($(mkIdent (m ++ `SagaInput ++ Name.mkSimple s.getString!)) input))
    | none => `(($M).saga id input)
  let pattern (c : Name) (k : Nat) : CommandElabM Term :=
    if k = 0 then `($(mkIdent c)) else `($(mkIdent c) ..)
  -- The tables, with the numbers so far.
  let tables (E S : Array Nat) (proved : Bool) : CommandElabM (Array Syntax) := do
    let eventAlts ← (events.zip E).mapM fun ((a, c, k), n) => do
      `(Lean.Parser.Term.matchAltExpr| | $(mkIdent a), $(← pattern c k) => $(quote n))
    let sendAlts ← (commands.zip S).mapM fun ((a, c, k), n) => do
      `(Lean.Parser.Term.matchAltExpr| | ⟨$(mkIdent a), _, $(← pattern c k)⟩ => $(quote n))
    let emits ← if proved then
        `(by
          intro n ctx state command es accepted
          cases n <;> cases command <;> records_fit accepted [$decides,*])
      else `(sorry) -- while searching only: what is searched with is never kept
    return #[
      ← `(/-- What each event weighs. -/
        @[simp] def $eventWeight : (n : ($M).signature.aggregates.Name) →
            (($M).signature.aggregates.of n).Event → Nat
          $[$(eventAlts.map fun alt => ⟨alt.raw⟩):matchAlt]*),
      ← `(/-- What each command weighs: at least what it records. -/
        @[simp] def $sendWeight : Alchemy.Send ($M).signature.aggregates → Nat
          $[$(sendAlts.map fun alt => ⟨alt.raw⟩):matchAlt]*),
      ← `(/-- What each event and each command weighs. Found by `comes_to_rest`. -/
        def $ranking : Alchemy.Model.Ranking $M where
          event := $eventWeight
          send := $sendWeight
          emits := $emits)]
  -- While searching only: each saga's rank so far, assumed, and never kept.
  let assumed (J : Array Nat) : CommandElabM (Array Syntax) :=
    (sagas.zip J).mapM fun (s, j) => do
      `(theorem $(sagaRank s) (id) (input) :
          Alchemy.Model.Ranked $ranking $(← sagaRun s) $(quote j) := sorry)
  let earlier (i : Nat) : Array Term := (sagas.extract 0 i).map fun s => (sagaRank s : Term)
  let all : Array Term := sagas.map fun s => (sagaRank s : Term)
  let policies ← liftTermElabM do
    let mut list ← whnfR (← elabTerm (← `(($M).policies)) none)
    let mut found := #[]
    while list.isAppOfArity ``List.cons 3 do
      let .const p _ := (list.getArg! 1).getAppFn
        | throwError "the policies of {model} are not written as a list of names"
      found := found.push p
      list ← whnfR (list.getArg! 2)
    unless list.isAppOfArity ``List.nil 1 do
      throwError "the policies of {model} are not written as a list"
    pure found
  let weigh (R : Array (Array Nat)) : Array Nat := R.map fun ranks => 1 + ranks.foldl (· + ·) 0
  -- Look for the least numbers that hold together, starting from nothing. Each
  -- round starts from what the last one found: the numbers only go up.
  let mut R : Array (Array Nat) := events.map fun _ => policies.map fun _ => 0
  let mut S := commands.map fun _ => 0
  let mut J := sagas.map fun _ => 0
  let mut settled := false
  let mut growing : Array Name := #[]
  for round in [0 : events.size + commands.size + sagas.size + 3] do
    let E := weigh R
    let S' ← scratch (← tables E S false) do
      (commands.zip S).mapM fun ((a, c, k), n) => do
        let xs := fields k
        found (← `((by least_such from $(quote n)
            (intros; rename_i accepted; records_fit accepted [$decides,*]) :
          { n : Nat // ∀ ctx state $xs* es,
              (($M).signature.aggregates.of $(mkIdent a)).decide ctx state ($(mkIdent c) $xs*) = .ok es →
              (es.map ($eventWeight $(mkIdent a))).sum ≤ n })))
    -- What the sagas and reactions weigh follows from what the commands weigh:
    -- if those have not moved since the last round, nothing else will.
    if round > 0 && S' == S then
      settled := true
      break
    let J' ← scratch ((← tables E S' false) ++ (← assumed J)) do
      (Array.range sagas.size).mapM fun i => do
        found (← `((⟨_, by intro id input; ranked_least from $(quote J[i]!) $ranking [$(earlier i),*]⟩ :
          { j : Nat // ∀ id input, Alchemy.Model.Ranked $ranking $(← sagaRun sagas[i]!) j })))
    let R' ← scratch ((← tables E S' false) ++ (← assumed J')) do
      (events.zip R).mapM fun ((a, c, k), ranks) => do
        let xs := fields k
        (policies.zip ranks).mapM fun (p, r) => do
          found (← `((⟨_, by intros; ranked_least from $(quote r) $ranking [$all,*]⟩ :
            { r : Nat // ∀ history id $xs* seq time, Alchemy.Model.Ranked $ranking
                (($(mkIdent p)).react history ⟨$(mkIdent a), id, $(mkIdent c) $xs*, seq, time⟩) r })))
    growing := ((events.zip (weigh R')).zip E).filterMap fun (((_, c, _), now), before) =>
      if now != before then some c else none
    R := R'; S := S'; J := J'
  unless settled do
    throwError "{model} may never come to rest: no weights hold together, because some reaction \
      leads back to the event it reacts to. These kept growing: {growing}"
  let E := weigh R
  -- The numbers hold together: state them, and prove everything with them.
  for c in ← tables E S true do elabCommand c
  for i in [0:sagas.size] do
    elabCommand (← `(
      /-- The saga's rank: it takes at most this many steps, whatever it is answered. -/
      theorem $(sagaRank sagas[i]!) (id) (input) :
          Alchemy.Model.Ranked $ranking $(← sagaRun sagas[i]!) $(quote J[i]!) := by
        try simp only [behaviour]
        ranked $ranking [$(earlier i),*]))
  -- Each event's case is proved with the ranks found for it.
  let mut shapes : Array (Array Nat) := #[]
  for ranks in R do
    unless shapes.contains ranks do shapes := shapes.push ranks
  let cases ← shapes.mapM fun ranks =>
    `(tactic| reactions_ranked $ranking [$all,*] [$(ranks.map fun r => (quote r : TSyntax `num)),*])
  elabCommand (← `(
    /-- Every event weighs more than the reactions to it. -/
    theorem $(at_ `reacts) : Alchemy.Model.Ranking.Reacts $ranking := by
      intro history e
      obtain ⟨source, id, event, seq, time⟩ := e
      cases source <;> cases event <;> first $[| $cases:tactic]*))
  elabCommand (← `(
    /--
    The model comes to rest. From any world it can reach, after some number of
    steps nothing can go on without a caller, an outside answer or the clock.
    -/
    theorem $(at_ `comesToRest) (w : Alchemy.World ($M).signature) (reach : ($M).Reachable w) :
        ∃ steps, ($M).AtRest (($M).settle steps w) :=
      Alchemy.Model.Ranking.comesToRest $ranking $(at_ `reacts) w reach))
  -- When every reaction is calm, the number of steps can be written down too.
  let calmly ← `(∀ history e,
    Alchemy.Model.AllCalm (m := $M) (($M).policies.map fun p => p.react history e))
  let proof ← `(by
          intro history e
          obtain ⟨source, id, event, seq, time⟩ := e
          cases source <;> cases event <;>
            (repeat' first
              | exact Alchemy.Model.AllCalm.nil
              | (apply Alchemy.Model.AllCalm.cons
                 focus (calm))) <;> done)
  let calm ← liftTermElabM <| withoutErrToSorry do
    let saved ← saveState
    let messages ← Core.getMessageLog
    Core.resetMessageLog
    let ok ← try
        discard <| elabTermEnsuringType (← `(($proof : $calmly))) none
        synthesizeSyntheticMVarsNoPostponing
        pure !(← Core.getMessageLog).hasErrors
      catch _ => pure false
    saved.restore
    Core.setMessageLog messages
    pure ok
  if calm then
    elabCommand (← `(
      /-- Every reaction only calls outside, tells an aggregate, and ends. -/
      theorem $(at_ `calm) : $calmly := $proof))
    elabCommand (← `(
      /--
      How many steps it takes. From any world the model can reach, it is at
      rest after as many steps as that world weighs.
      -/
      theorem $(at_ `comesToRestIn) (w : Alchemy.World ($M).signature) (reach : ($M).Reachable w) :
          ($M).AtRest (($M).settle
            ((Alchemy.Model.Ranking.weights $ranking $(at_ `reacts)).measure w) w) :=
        Alchemy.Model.Ranking.comesToRestIn $ranking $(at_ `reacts) $(at_ `calm) w reach))

end Alchemy
