import Alchemy.Story
import Alchemy.Cloud.Sim
import Alchemy.Cloud.Hosted

/-!
# A story, told to the stack

A story is written in the model's own words: commands, events, views. Told to
the model alone, the story plays the outside systems. Told to a stack, each
command goes in through the host that runs the model, and the stack's own
bindings answer the model's calls. One story can be told both ways.
-/

namespace Alchemy.Cloud

variable {K : Type} [Cloud K]

/-- How a stack is told a story about the model it hosts. -/
structure Telling (m : Model) (sim : Sim K) where
  kind : K
  /-- The host that runs the model. -/
  host : Ref kind
  /-- A command, as the request that sends it. -/
  request : Send m.signature.aggregates → Cloud.Request kind
  /-- The model as the cloud has it. -/
  world : sim.State → Alchemy.World m.signature

namespace Graph

variable {m : Model} {sim : Sim K}

/-- Where a telling stands: the stack as it runs, and what the story has asserted. -/
structure Told (m : Model) (sim : Sim K) where
  running : Running K sim
  asserted : List Nat := []
  pending : Option ((n : m.signature.aggregates.Name) × (m.signature.aggregates.of n).Rejection) :=
    none

def tellStep (g : Graph K) (telling : Telling m sim) (told : Told m sim) :
    Story.ModelStep m → Except String (Told m sim)
  | .when s =>
    if told.pending.isSome then .error "a rejection was not asserted before the next command"
    else
      let before := telling.world told.running.state
      let pending :=
        match before.toRecorded.outcome before.now s with
        | .ok _ => none
        | .error r => some ⟨s.to, r⟩
      match g.invoke telling.host (telling.request s) told.running with
      | (some (.ok _), running) =>
        let running := g.settle 1000 running
        if running.failures.isEmpty then .ok { told with running, pending }
        else .error s!"a listener failed: {running.failures}"
      | (some (.error why), _) => .error s!"the host failed: {why}"
      | (none, _) => .error "the stack has no such host"
  -- The stack answers the model's calls itself, so the story's own answers are passed over.
  -- If they are not the answers the stack gives, what is recorded differs and a later step fails.
  | .call _ | .answer .. => .ok told
  | .given .. | .decide .. | .pass _ | .next _ => .error "this step is not told to a stack"
  | step =>
    -- Everything else only looks: at what was recorded, at a state, at a view.
    match Story.stepModel
        { world := telling.world told.running.state, asserted := told.asserted,
          pending := told.pending } step with
    | .ok progress => .ok { told with asserted := progress.asserted, pending := progress.pending }
    | .error why => .error why

def tellAll (g : Graph K) (telling : Telling m sim) (told : Told m sim) :
    List (Story.ModelStep m) → Nat → Except String Unit
  | [], index =>
    Story.runModel
      { world := telling.world told.running.state, asserted := told.asserted,
        pending := told.pending } [] index
  | step :: rest, index =>
    match g.tellStep telling told step with
    | .ok told' => tellAll g telling told' rest (index + 1)
    | .error why => .error s!"step {index + 1}: {why}"

/-- Tells a story to the stack. `.ok ()` when every step holds. -/
def tell (g : Graph K) (telling : Telling m sim) (steps : List (Story.ModelStep m)) :
    Except String Unit :=
  g.tellAll telling { running := g.start sim } steps 0

/-- Whether a story holds of the stack. -/
def tells (g : Graph K) (telling : Telling m sim) (steps : List (Story.ModelStep m)) : Bool :=
  match g.tell telling steps with
  | .ok _ => true
  | .error _ => false

end Graph

end Alchemy.Cloud
