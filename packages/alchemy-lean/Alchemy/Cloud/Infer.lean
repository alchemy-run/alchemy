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
    (sites : List (Access K × String)) (go : need ≤ role → Host role α) : Host role α := do
  let ⟨le⟩ ← Host.grant need
  Host.note sites
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

/-- A call, as it is written, with where it is. -/
private def siteOf (stx : Syntax) : TermElabM String := do
  let text := (stx.reprint.getD "").trimAscii.toString
  let text := " ".intercalate ((text.splitOn "\n").map (·.trimAscii.toString))
  let text := if text.length > 60 then (text.take 57).toString ++ "…" else text
  let file := (System.FilePath.mk (← getFileName)).fileName.getD ""
  match stx.getPos? with
  | some pos => return s!"{file}:{(← getFileMap).toPosition pos |>.line}  {text}"
  | none => return text

/--
Where each grant is asked for. The block is checked once with its role left
open, so each call that needs a grant is left waiting, with its place in the
source. Nothing of that check is kept but the places.
-/
private def sitesOf (body : Syntax) (role blockType : Expr) : TermElabM (Array (Expr × String)) := do
  try
    withoutModifyingState do
      let open_ ← mkFreshExprMVar (← inferType role)
      let blockType := blockType.replaceFVar role open_
      let _ ← elabTermEnsuringType body blockType
      synthesizeSyntheticMVars (postpone := .yes)
      let mut found := #[]
      for waiting in (← get).pendingMVars do
        let some decl ← getSyntheticMVarDecl? waiting | continue
        let type ← instantiateMVars (← waiting.getType)
        if type.isAppOf ``Alchemy.Cloud.Has && type.getAppNumArgs ≥ 2 && (type.getArg! (type.getAppNumArgs - 2)).isMVar then
          let need := type.getArg! (type.getAppNumArgs - 1)
          unless need.hasMVar do
            found := found.push (need, ← siteOf decl.stx)
      return found
  catch _ => return #[]

/-- The block for one role, with every grant it asks for taken at the start. -/
private def grantedFor (body : Syntax) (role blockType : Expr) : TermElabM Expr := do
  let access ← inferType role
  let places ← sitesOf body role blockType
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
        read off the code"
  let empty ← mkAppOptM ``EmptyCollection.emptyCollection #[access, none]
  let all ← needs.foldlM (init := none) fun (all : Option Expr) need => do
    match all with
    | none => return some need
    | some all => return some (← mkAppM ``Union.union #[all, need])
  let all := all.getD empty
  -- Each grant with the calls that ask for it.
  let siteType ← mkAppM ``Prod #[access, mkConst ``String]
  let mut sites : Array Expr := #[]
  for need in needs do
    for (asked, place) in places do
      if ← withoutModifyingState (isDefEq asked need) then
        sites := sites.push (← mkAppM ``Prod.mk #[need, mkStrLit place])
  let siteList ← mkListLit siteType sites.toList
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
  mkAppM ``Alchemy.Cloud.Host.granted #[all, siteList, withGrant]

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

namespace Alchemy.Cloud

open Lean Elab Term Meta Command

/--
`helper name (params) : type := body` defines a function a host's code can
call, and works out the grants its body asks for. They become the function's
own requirements, so nobody lists them: a host that calls it is asked for them.
The type names the role as `role`.
-/
syntax (name := helperCommand) (docComment)? "helper " ident bracketedBinder* " : " term " := " term : command

@[command_elab helperCommand] def elabHelper : CommandElab := fun stx => do
  let `($[$doc:docComment]? helper $name:ident $binders* : $type := $body) := stx | throwUnsupportedSyntax
  let declName := (← getCurrNamespace) ++ name.getId
  runTermElabM fun _ => do
    elabBinders binders fun params => do
      -- The role is the parameter the result's type runs under.
      let roleParam? ← params.findM? fun param => do
        return (← inferType param).isAppOf ``Alchemy.Cloud.Access
      let some role := roleParam? | throwError "a helper takes its role as a parameter: {lit}role : Access K{rit}"
      let access ← inferType role
      let resultType ← Term.elabType type
      let standType ← withLocalDeclD `need access fun need => do
        mkForallFVars #[need] (← mkAppM ``Alchemy.Cloud.Has #[role, need])
      let block ← withLocalDecl `granted .instImplicit standType fun stand => do
        let value ← elabTermEnsuringType body resultType
        synthesizeSyntheticMVarsNoPostponing
        mkLambdaFVars #[stand] (← instantiateMVars value)
      let .lam _ _ blockBody _ := block | throwError "helper: unexpected body"
      let marker := Lean.mkConst `Alchemy.Cloud.Infer.marker
      let marked := blockBody.instantiate1 marker
      let needs := askedFor marker marked #[]
      for need in needs do
        if need.hasLooseBVars then
          throwError "a call's resource is only known when the code runs, so its grant cannot be \
            read off the code"
      -- One requirement per grant the body asks for.
      let rec go (i : Nat) (given : Array Expr) : TermElabM Unit := do
        if h : i < needs.size then
          let hasType ← mkAppM ``Alchemy.Cloud.Has #[role, needs[i]]
          withLocalDecl (Name.mkSimple s!"grant{i}") .instImplicit hasType fun inst =>
            go (i + 1) (given.push inst)
        else
          let filled := marked.replace fun e =>
            match e with
            | .app f a =>
              if f == marker then (needs.findIdx? (· == a)).bind fun j => given[j]? else none
            | _ => none
          let all := params ++ given
          let value ← mkLambdaFVars all filled
          let declType ← mkForallFVars all resultType
          let value ← instantiateMVars value
          let declType ← instantiateMVars declType
          addAndCompile <| .defnDecl {
            name := declName, levelParams := [], type := declType, value
            hints := .abbrev, safety := .safe }
          if let some doc := doc then addDocString declName (mkNullNode binders) doc
      go 0 #[]
where
  lit := "{"
  rit := "}"

end Alchemy.Cloud
