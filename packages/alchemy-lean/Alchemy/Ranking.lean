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

/-- The least number an attempt works for: doubled until one does, then closed in on. -/
def leastWorking (what : String) (attempt : Nat → TacticM Unit) (limit : Nat := 4096) :
    TacticM Unit := do
  let works (k : Nat) : TacticM Bool := do
    let saved ← saveState
    let ok ← try attempt k; pure true catch _ => pure false
    saved.restore
    pure ok
  let mut high := 1
  while !(← works high) do
    if high ≥ limit then
      -- Run it once more, so the reason it fails is the error shown.
      attempt high
      throwError "no {what} up to {limit} is enough"
    high := high * 2
  let mut low := high / 2
  while low + 1 < high do
    let middle := (low + high) / 2
    if ← works middle then high := middle else low := middle
  attempt high

/-- Closes a goal `{ n // P n }` with the least `n` the tactics prove `P n` for. -/
syntax "least_such " tacticSeq : tactic

elab_rules : tactic
  | `(tactic| least_such $tactics) =>
    leastWorking "number" fun k => do
      evalTactic (← `(tactic| (refine ⟨$(quote k), ?_⟩; ($tactics); done)))

/-- Gives a program the least rank it has: the goal's rank is left open and filled in. -/
syntax "ranked_least " ident " [" term,* "]" : tactic

elab_rules : tactic
  | `(tactic| ranked_least $ranking [$sagas,*]) => do
    -- Open the program up once, so every `if` in it is in sight.
    evalTactic (← `(tactic| try simp only [behaviour]))
    leastWorking "rank" fun k => do
      evalTactic (← `(tactic| focus (
        refine Alchemy.Model.Ranked.mono (a := $(quote k)) ?_ (Nat.le_refl _)
        ranked $ranking [$sagas,*]
        done)))

/-- Ranks each reaction to one event, each with the least rank it has. -/
syntax "reaction_ranks " ident " [" term,* "]" : tactic

macro_rules
  | `(tactic| reaction_ranks $ranking [$sagas,*]) =>
    `(tactic| focus (
      (repeat' first
        | exact Alchemy.Model.Ranking.programs.nil
        | (apply Alchemy.Model.Ranking.programs.cons
           focus (ranked_least $ranking [$sagas,*])))
      done))

/-- Proves that an event outweighs the reactions to it: `reactions Bank.ranking [Bank.rank_Payout]`. -/
syntax "reactions " ident " [" term,* "]" : tactic

macro_rules
  | `(tactic| reactions $ranking [$sagas,*]) =>
    `(tactic| (
      apply Alchemy.Model.Ranking.reacting
      reaction_ranks $ranking [$sagas,*]
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
  -- Look for the least numbers that hold together, starting from nothing.
  let mut E := events.map fun _ => 0
  let mut S := commands.map fun _ => 0
  let mut J := sagas.map fun _ => 0
  let mut settled := false
  for _ in [0:64] do
    let J' ← scratch ((← tables E S false) ++ (← assumed J)) do
      (Array.range sagas.size).mapM fun i => do
        found (← `((⟨_, by intro id input; ranked_least $ranking [$(earlier i),*]⟩ :
          { j : Nat // ∀ id input, Alchemy.Model.Ranked $ranking $(← sagaRun sagas[i]!) j })))
    let E' ← scratch ((← tables E S false) ++ (← assumed J')) do
      events.mapM fun (a, c, k) => do
        let xs := fields k
        let total ← found (← `((⟨_, by intros; reaction_ranks $ranking [$all,*]⟩ :
          { total : Nat // ∀ history id $xs* seq time, Alchemy.Model.Ranking.programs $ranking
              (($M).policies.map fun p =>
                p.react history ⟨$(mkIdent a), id, $(mkIdent c) $xs*, seq, time⟩) total })))
        return 1 + total
    let S' ← scratch (← tables E' S false) do
      commands.mapM fun (a, c, k) => do
        let xs := fields k
        found (← `((by least_such (intros; rename_i accepted; records_fit accepted [$decides,*]) :
          { n : Nat // ∀ ctx state $xs* es,
              (($M).signature.aggregates.of $(mkIdent a)).decide ctx state ($(mkIdent c) $xs*) = .ok es →
              (es.map ($eventWeight $(mkIdent a))).sum ≤ n })))
    if E' == E && S' == S && J' == J then
      settled := true
      break
    E := E'; S := S'; J := J'
  unless settled do
    throwError "no weights hold together: some reaction feeds itself, so {model} may never come to rest"
  -- The numbers hold together: state them, and prove everything with them.
  for c in ← tables E S true do elabCommand c
  for i in [0:sagas.size] do
    elabCommand (← `(
      /-- The saga's rank: it takes at most this many steps, whatever it is answered. -/
      theorem $(sagaRank sagas[i]!) (id) (input) :
          Alchemy.Model.Ranked $ranking $(← sagaRun sagas[i]!) $(quote J[i]!) := by
        try simp only [behaviour]
        ranked $ranking [$(earlier i),*]))
  elabCommand (← `(
    /-- Every event weighs more than the reactions to it. -/
    theorem $(at_ `reacts) : Alchemy.Model.Ranking.Reacts $ranking := by
      intro history e
      obtain ⟨source, id, event, seq, time⟩ := e
      cases source <;> cases event <;> reactions $ranking [$all,*]))
  elabCommand (← `(
    /--
    The model comes to rest. From any world it can reach, after some number of
    steps nothing can go on without a caller, an outside answer or the clock.
    -/
    theorem $(at_ `comesToRest) (w : Alchemy.World ($M).signature) (reach : ($M).Reachable w) :
        ∃ steps, ($M).AtRest (($M).settle steps w) :=
      Alchemy.Model.Ranking.comesToRest $ranking $(at_ `reacts) w reach))

end Alchemy
