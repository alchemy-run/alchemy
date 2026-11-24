import Alchemy.Cloud.Engine
import Alchemy.Cloud.Host

/-!
# Running a stack from the command line

A stack is a value, so its graph and its plan are computed from it. This
prints them: the same graph and the same plan the theorems are about.
-/

namespace Alchemy.Cloud
open Distilled (Api Model)

variable {K : Type} [Cloud K]

def Action.sign : Action → String
  | .create => "+ create "
  | .update => "~ update "
  | .replace => "± replace"
  | .noop => "  no-op  "
  | .delete => "- delete "

namespace Graph

/-- The graph as text: each resource, what it needs, what it may do, and what it listens to. -/
def report (g : Graph K) (grant : Attempt K → String) (why : Bool := false) : String :=
  String.intercalate "\n" <| g.order.filterMap fun id => (g.find id).map fun node =>
    let needs := if node.needs.isEmpty then "" else s!"\n    needs      {", ".intercalate node.needs}"
    let grants := node.access.atoms.map fun atom =>
      let calls := if why then (g.why id atom).map fun call => s!"\n                 ← {call}" else []
      s!"\n    may        {grant atom}{String.join calls}"
    let listens := match node.serve with
      | some serve => serve.on.map fun sub => s!"\n    consumes   {sub.source.id}"
      | none => []
    s!"  {id}{needs}{String.join grants}{String.join listens}"

end Graph

/-- The plan as text. -/
def planReport (plan : List (String × Action)) : String :=
  let lines := plan.map fun (id, action) => s!"  {action.sign}  {id}"
  let count := fun (a : Action) => (plan.filter (·.2 == a)).length
  String.intercalate "\n" lines ++
    s!"\n\n  {count .create} to create, {count .update} to update, {count .replace} to replace, " ++
    s!"{count .delete} to delete, {count .noop} unchanged"

/--
`graph [stage]` prints the stack's graph, and with `--why` the call that asks for each grant. `plan [stage]` prints the plan for a
fresh account, and `plan [stage] after [stage]` the plan for an account the
other stage was deployed to. Deploys are to the model of the cloud, in memory.
-/
def Stack.cli {Out : Type} {api : Api} {m : Model api} (stack : Stack K Out)
    (providers : Providers K api) (fresh : World K m) (grant : Attempt K → String)
    (args : List String) : IO UInt32 := do
  let stageOf := fun (i : Nat) => (args.filter (· != "--why")).getD i "dev"
  let build := fun (stage : String) =>
    match stack.build stage with
    | .ok (_, graph) =>
      if graph.deployable then Except.ok graph
      else .error s!"{stack.name} cannot be deployed: a resource is missing or resources wait on each other"
    | .error why => .error s!"{stack.name} does not build: {why}"
  match args with
  | "graph" :: _ =>
    match build (stageOf 1) with
    | .error why => IO.eprintln why; return 1
    | .ok graph =>
      IO.println s!"{stack.name} ({stageOf 1})\n\n{graph.report grant (args.contains "--why")}"
      return 0
  | "plan" :: _ =>
    match build (stageOf 1) with
    | .error why => IO.eprintln why; return 1
    | .ok graph =>
      let world ← match args with
        | [_, _, "after", earlier] =>
          match build earlier with
          | .ok before => pure (apply providers m before fresh).1
          | .error why => IO.eprintln why; return 1
        | _ => pure fresh
      let from_ := match args with
        | [_, _, "after", earlier] => s!" after {earlier}"
        | _ => " on a fresh account"
      IO.println s!"{stack.name} ({stageOf 1}){from_}\n\n{planReport (plan providers graph world.state)}"
      return 0
  | _ =>
    IO.println s!"usage: graph [stage] | plan [stage] | plan [stage] after [stage]"
    return 1

end Alchemy.Cloud
