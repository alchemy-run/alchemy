import Lean
import Alchemy.Cloud.Sim
import Alchemy.Aggregate

/-!
# Tactics

What settles the common claims about a stack.
-/

namespace Alchemy.Cloud

open Lean Elab Term Meta in
/-- A term, computed: `computed% prod.roles` is the list the stack builds. -/
elab "computed% " t:term : term => do
  let e ← instantiateMVars (← elabTerm t none)
  withTransparency .all (reduce e (skipProofs := true) (skipTypes := true))

/--
Settles a claim about who may do what in a graph: `access in prod`, or `access in prod using [BucketOp.covers]`. It computes
each host's role from the stack, so nobody writes the roles down. Facts about
how a kind's grants cover one another go in the list.
-/
syntax "access" " in " term (" using " "[" Lean.Parser.Tactic.simpLemma,* "]")? : tactic

macro_rules
  | `(tactic| access in $g) =>
    `(tactic| (
        have roles : Graph.roles $g = computed% (Graph.roles $g) := rfl
        simp [Graph.mem_whoCan, Graph.can, Access.permits, permitsOn, Kinds.covers,
          roles] at *))
  | `(tactic| access in $g using [$lemmas,*]) =>
    `(tactic| (
        have roles : Graph.roles $g = computed% (Graph.roles $g) := rfl
        simp [Graph.mem_whoCan, Graph.can, Access.permits, permitsOn, Kinds.covers,
          roles, $lemmas,*] at *))

end Alchemy.Cloud

namespace Alchemy

/--
Proves that an aggregate keeps a rule: `aggregate_rule [decide, evolve, Rule]`.
It takes each command in turn, each way `decide` can answer it, and checks the
events it records. The names are the `decide` function, then whatever else the
rule is stated with.
-/
syntax "aggregate_rule" " [" ident,+ "]" : tactic

open Lean in
macro_rules
  | `(tactic| aggregate_rule [$names,*]) => do
    let names := names.getElems
    let decide := names[0]!
    let unfolded := #[mkIdent ``Alchemy.Aggregate.apply] ++ names.extract 1 names.size
    let params ← unfolded.mapM fun name => `(Lean.Parser.Tactic.grindParam| $name:ident)
    `(tactic| (
        intro ctx s c es h eq
        cases c <;> simp only [$decide:ident] at eq <;> (repeat' split at eq) <;>
          grind [$params,*]))

end Alchemy
