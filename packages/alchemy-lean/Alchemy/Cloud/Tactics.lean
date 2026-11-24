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

namespace Alchemy.Cloud

variable {K : Type} [Cloud K]

/-- A kind of thing that can be done to a resource: "writing this bucket under this prefix". -/
structure Doing (K : Type) [Cloud K] where
  /-- What tells one such attempt from another: the rest of a key, say. -/
  Detail : Type
  attempt : Detail → Attempt K

namespace Graph

/-- Only these hosts can do this. -/
def only (g : Graph K) {k : K} (hosts : List (Ref k)) (action : Doing K) : Prop :=
  ∀ detail host, host ∈ g.whoCan (action.attempt detail) → host ∈ hosts.map (·.id)

/-- Nothing in the stack can do this. -/
def nobody (g : Graph K) (action : Doing K) : Prop :=
  ∀ detail host, host ∉ g.whoCan (action.attempt detail)

/-- This host can never do this. -/
def never (g : Graph K) {k : K} (host : Ref k) (action : Doing K) : Prop :=
  ∀ detail, g.can host.id (action.attempt detail) = false

/-- This host can do this, whatever the detail. -/
def may (g : Graph K) {k : K} (host : Ref k) (action : Doing K) : Prop :=
  ∀ detail, g.can host.id (action.attempt detail) = true

end Graph

open Lean Elab Tactic Meta in
/-- Stops with the stack's roles, for a rule that does not hold of them. -/
elab "roles_do_not_allow " g:term : tactic => do
  let roles ← Term.elabTerm (← `(Graph.roles $g)) none
  let roles ← withTransparency .all (reduce roles (skipProofs := true) (skipTypes := true))
  throwError "This rule does not hold of the stack. Some role allows what the rule forbids, or \
    lacks what it requires. The roles, as the code gives them:{indentExpr roles}\n\
    `graph --why` prints the call behind each permission."

/--
Proves a rule about who can do what in a stack: `stack_rule in prod using [out]`. The
list names what the rule is stated with: the stack's outputs, and how grants
cover one another.
-/
syntax "stack_rule" " in " term " using " "[" Lean.Parser.Tactic.simpLemma,* "]" : tactic

macro_rules
  | `(tactic| stack_rule in $g using [$lemmas,*]) =>
    `(tactic| (
        try simp only [Graph.only, Graph.nobody, Graph.never, Graph.may]
        intros
        have roles : Graph.roles $g = computed% (Graph.roles $g) := rfl
        first
          | (simp [Graph.mem_whoCan, Graph.can, Access.permits, permitsOn, Kinds.covers,
              roles, $lemmas,*] at * <;> done)
          | (simp [Graph.mem_whoCan, Graph.can, Access.permits, permitsOn, Kinds.covers,
              roles, $lemmas,*] at * <;> grind)
          | roles_do_not_allow $g))

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

/--
Proves a property of what commands do to the state, such as `Idempotent` or
`Commute`: `command_law [decide, evolve]`. It takes each command and each way
`decide` can answer it.
-/
syntax "command_law" " [" ident,+ "]" : tactic

open Lean in
macro_rules
  | `(tactic| command_law [$names,*]) => do
    let unfolded := #[mkIdent ``Alchemy.Aggregate.step, mkIdent ``Alchemy.Aggregate.apply]
      ++ names.getElems
    let params ← unfolded.mapM fun name => `(Lean.Parser.Tactic.simpLemma| $name:ident)
    let grinds ← unfolded.mapM fun name => `(Lean.Parser.Tactic.grindParam| $name:ident)
    `(tactic| (
        simp only [Alchemy.Aggregate.Idempotent, Alchemy.Aggregate.IdempotentAt,
          Alchemy.Aggregate.Commute]
        intros
        first
          | (rename_i c _ _; cases c <;> simp [$params,*] <;> (repeat' split) <;> grind [$grinds,*])
          | (simp [$params,*] <;> (repeat' split) <;> grind [$grinds,*])))

end Alchemy
