import Lean
import Alchemy.Cloud.Host

/-!
# A role read off the code

`granted% body` checks a host's block and finds every grant its code asks for,
wherever in the block the call is written. The host's role is those grants.
Nobody takes a binding first: calling an operation is what asks for the grant.
-/

namespace Alchemy.Cloud

variable {K : Type} [Cloud K]

/-- Ask for a grant, and go on with the proof that the role includes it. -/
def Host.granted {role : Access K} {α : Type} (need : Access K)
    (go : need ≤ role → Host role α) : Host role α := do
  let ⟨le⟩ ← Host.grant need
  go le

open Lean Elab Term Meta

/-- Every grant the block asks for: each use of the stand-in instance, with what it was asked for. -/
private partial def askedFor (stand : Expr) (e : Expr) (found : Array Expr) : Array Expr :=
  match e with
  | .app f a =>
    if f == stand then (if found.contains a then found else found.push a)
    else askedFor stand a (askedFor stand f found)
  | .lam _ t b _ | .forallE _ t b _ => askedFor stand b (askedFor stand t found)
  | .letE _ t v b _ => askedFor stand b (askedFor stand v (askedFor stand t found))
  | .mdata _ b | .proj _ _ b => askedFor stand b found
  | _ => found

/-- The block for one role, with every grant it asks for taken at the start. -/
private def grantedFor (body : Syntax) (role blockType : Expr) : TermElabM Expr := do
  let access ← inferType role
  -- While the block is checked, any grant it asks for is taken as given.
  let standType ← withLocalDeclD `need access fun need => do
    mkForallFVars #[need] (← mkAppM ``Alchemy.Cloud.Has #[role, need])
  let block ← withLocalDecl `granted .instImplicit standType fun stand => do
    let block ← elabTermEnsuringType body blockType
    synthesizeSyntheticMVarsNoPostponing
    mkLambdaFVars #[stand] (← instantiateMVars block)
  let .lam _ _ blockBody _ := block | throwError "granted%: unexpected block"
  let marker := Lean.mkConst `Alchemy.Cloud.Infer.marker
  let marked := blockBody.instantiate1 marker
  let needs := askedFor marker marked #[]
  for need in needs do
    if need.hasLooseBVars then
      throwError "a call's resource is only known when the code runs, so its grant cannot be \
        read off the code: take the binding as a step of the block instead"
  let empty ← mkAppOptM ``EmptyCollection.emptyCollection #[access, none]
  let all ← needs.foldlM (init := none) fun (all : Option Expr) need => do
    match all with
    | none => return some need
    | some all => return some (← mkAppM ``Union.union #[all, need])
  let all := all.getD empty
  let withGrant ← withLocalDeclD `le (← mkAppM ``LE.le #[all, role]) fun le => do
    let mut proofs : Array (Expr × Expr) := #[]
    for need in needs do
      let within ← synthInstance (← mkAppM ``Alchemy.Cloud.Has #[all, need])
      let part ← mkProjection within `le
      let has ← mkAppM ``Alchemy.Cloud.Has.mk #[← mkAppM ``Alchemy.Cloud.Access.le_trans #[part, le]]
      proofs := proofs.push (need, has)
    let filled := marked.replace fun e =>
      match e with
      | .app f a => if f == marker then (proofs.find? (·.1 == a)).map (·.2) else none
      | _ => none
    mkLambdaFVars #[le] filled
  mkAppM ``Alchemy.Cloud.Host.granted #[all, withGrant]

/--
`granted% block`: the block, with its role worked out from the calls in it.
-/
elab "granted% " body:term : term <= expected => do
  tryPostponeIfMVar expected
  let expected ← instantiateMVars expected
  if expected.isForall then
    forallBoundedTelescope expected (some 1) fun binders blockType => do
      mkLambdaFVars binders (← grantedFor body binders[0]! blockType)
  else
    -- Lean has already taken the role as a variable: it is the block type's own.
    let args := expected.getAppArgs
    unless expected.getAppFn.isConstOf ``Alchemy.Cloud.Host && args.size ≥ 3 do
      throwError "granted% is for a host's block, but this is expected to be{indentExpr expected}"
    grantedFor body args[2]! expected

end Alchemy.Cloud
