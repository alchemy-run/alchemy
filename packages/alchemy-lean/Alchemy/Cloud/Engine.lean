import Alchemy.Cloud.Provider

/-!
# Plan and apply

The engine keeps a row of state for each resource and drives providers until
the cloud matches a graph. It writes what it is about to do before it does it,
so that a failure or a crash at any point leaves nothing in the cloud that the
state has lost track of. That is proved here for every provider that is
`Lawful`, not tested case by case.
-/

namespace Alchemy.Cloud
open Distilled (Api Eff Model)

variable {K : Type} [Cloud K] {api : Api}

/-- Where a resource is in its life. Every status but `ready` is a step that has begun and not finished. -/
inductive Status where
  | creating
  | updating
  | replacing
  | ready
  | deleting
deriving DecidableEq, Repr

/-- What the engine remembers about one resource. -/
structure Row (K : Type) [Cloud K] where
  kind : K
  id : String
  /-- Which instance of the resource is the current one. -/
  generation : Nat
  status : Status
  /-- The configuration it has, or is being brought to. -/
  props : Cloud.Props kind
  /-- Instances it replaced, still to be removed. -/
  old : List (Physical K) := []

namespace Row

def current (r : Row K) : Physical K := ⟨r.kind, r.id, r.generation⟩

/-- A row tracks its current instance and the ones it replaced. -/
def tracks (r : Row K) (y : Physical K) : Prop := y = r.current ∨ y ∈ r.old

/-- The row for a node of the graph. -/
def of (node : Node K) (generation : Nat) (status : Status) (old : List (Physical K)) : Row K :=
  { kind := node.kind, id := node.id, generation, status, props := node.props, old }

end Row

/-- The engine's memory: a row for each resource it manages. -/
structure State (K : Type) [Cloud K] where
  row : String → Option (Row K)
  /-- The ids that may have a row. -/
  ids : List String
  listed : ∀ id, row id ≠ none → id ∈ ids

namespace State

def empty : State K := ⟨fun _ => none, [], fun _ h => absurd rfl h⟩

def set (s : State K) (id : String) (r : Row K) : State K where
  row := fun i => if i = id then some r else s.row i
  ids := id :: s.ids
  listed := fun i h => by
    by_cases eq : i = id
    · simp [eq]
    · simp only [eq, ite_false] at h
      exact List.mem_cons_of_mem _ (s.listed i h)

def erase (s : State K) (id : String) : State K where
  row := fun i => if i = id then none else s.row i
  ids := s.ids
  listed := fun i h => by
    by_cases eq : i = id
    · simp [eq] at h
    · simp only [eq, ite_false] at h
      exact s.listed i h

/-- The state tracks a physical resource when some row does. -/
def tracks (s : State K) (y : Physical K) : Prop := ∃ id r, s.row id = some r ∧ r.tracks y

@[simp] theorem set_row_self (s : State K) (id : String) (r : Row K) : (s.set id r).row id = some r := by
  simp [set]

theorem set_row_of_ne (s : State K) {id other : String} (r : Row K) (ne : other ≠ id) :
    (s.set id r).row other = s.row other := by
  simp [set, ne]

/-- Replacing a row by one that tracks at least as much loses track of nothing. -/
theorem tracks_set {s : State K} {id : String} {r' : Row K}
    (keeps : ∀ r, s.row id = some r → ∀ y, r.tracks y → r'.tracks y)
    {y : Physical K} (h : s.tracks y) : (s.set id r').tracks y := by
  obtain ⟨i, r, at_, t⟩ := h
  by_cases eq : i = id
  · subst eq; exact ⟨i, r', by simp, keeps r at_ y t⟩
  · exact ⟨i, r, by rw [set_row_of_ne _ _ eq]; exact at_, t⟩

end State

/-- The engine's memory and the cloud it manages. -/
structure World (K : Type) [Cloud K] {api : Api} (m : Model api) where
  state : State K
  cloud : m.State

variable {m : Model api}

/-- What a provider's reconcile of a row does to the cloud. -/
def reconciled (ps : Providers K api) (m : Model api) (r : Row K) (cloud : m.State) :
    Except Failure (ps.Attrs r.kind) × m.State :=
  ((ps.provider r.kind).reconcile r.current.slot r.props).run m cloud

/-- What a provider's delete of a physical resource does to the cloud. -/
def deleted (ps : Providers K api) (m : Model api) (y : Physical K) (cloud : m.State) :
    Except Failure Unit × m.State :=
  ((ps.provider y.kind).delete y.slot).run m cloud

/--
Everything the engine may do. Each step may be the last: the engine can fail or
be killed after any of them.

A reconcile or a delete changes the cloud whether or not the state is written
afterwards, which is what a crash between the two looks like.
-/
inductive Step (ps : Providers K api) (m : Model api) : World K m → World K m → Prop
  /-- Write state that still tracks everything it tracked. -/
  | write {w : World K m} {s' : State K} (covers : ∀ y, w.state.tracks y → s'.tracks y) :
      Step ps m w ⟨s', w.cloud⟩
  /-- Reconcile a resource the state has a row for. -/
  | reconcile {w : World K m} {s' : State K} (id : String) (r : Row K)
      (has : w.state.row id = some r) (covers : ∀ y, w.state.tracks y → s'.tracks y) :
      Step ps m w ⟨s', (reconciled ps m r w.cloud).2⟩
  /-- Delete a resource the state tracks, and forget it only if the delete succeeded. -/
  | delete {w : World K m} {s' : State K} (y : Physical K) (tracked : w.state.tracks y)
      (covers : ∀ z, w.state.tracks z →
        z ≠ y ∨ (deleted ps m y w.cloud).1 ≠ .ok () → s'.tracks z) :
      Step ps m w ⟨s', (deleted ps m y w.cloud).2⟩

/-- Any number of steps. -/
inductive Steps (ps : Providers K api) (m : Model api) : World K m → World K m → Prop
  | done (w : World K m) : Steps ps m w w
  | next {a b c : World K m} : Steps ps m a b → Step ps m b c → Steps ps m a c

theorem Steps.trans {ps : Providers K api} {a b c : World K m}
    (ab : Steps ps m a b) (bc : Steps ps m b c) : Steps ps m a c := by
  induction bc with
  | done => exact ab
  | next _ step ih => exact .next ih step

/-- Nothing is lost: every resource that exists in the cloud is tracked by the state. -/
def Tracked {ps : Providers K api} (law : Lawful ps m) (w : World K m) : Prop :=
  ∀ y, law.present y w.cloud = true → w.state.tracks y

/-- No step loses track of a resource, whether the provider succeeds or fails. -/
theorem Step.tracked {ps : Providers K api} (law : Lawful ps m) {w w' : World K m}
    (step : Step ps m w w') (h : Tracked law w) : Tracked law w' := by
  cases step with
  | write covers => exact fun y present => covers y (h y present)
  | reconcile id r has covers =>
    intro y present
    by_cases eq : y = r.current
    · exact covers y ⟨id, r, has, .inl eq⟩
    · have frame := law.reconcile_frame r.kind r.current.slot r.props w.cloud y eq
      exact covers y (h y (by simpa [reconciled, frame] using present))
  | delete y₀ tracked covers =>
    intro y present
    by_cases eq : y = y₀
    · subst eq
      by_cases ok : (deleted ps m y w.cloud).1 = .ok ()
      · have gone := law.delete_ok y.kind y.slot w.cloud (deleted ps m y w.cloud).2
          (by simp only [deleted] at ok ⊢; rw [← ok])
        simp [show (⟨y.kind, y.slot.id, y.slot.generation⟩ : Physical K) = y from rfl] at gone
        simp [gone] at present
      · exact covers y tracked (.inr ok)
    · have frame := law.delete_frame y₀.kind y₀.slot w.cloud y eq
      exact covers y (h y (by simpa [deleted, frame] using present)) (.inl eq)

/--
The engine leaks nothing. Start with every existing resource tracked, take any
steps in any order, stop anywhere: every existing resource is still tracked, so
a later run can finish or remove it.
-/
theorem Steps.tracked {ps : Providers K api} (law : Lawful ps m) {w w' : World K m}
    (steps : Steps ps m w w') (h : Tracked law w) : Tracked law w' := by
  induction steps with
  | done => exact h
  | next _ step ih => exact step.tracked law ih

/-! ## Plan -/

/-- What it takes to bring a row to a node. A different kind of resource is always a replacement. -/
def diffRow (ps : Providers K api) (r : Row K) (node : Node K) : Diff :=
  if h : r.kind = node.kind then
    if r.id = node.id then (ps.provider node.kind).diff (h ▸ r.props) node.props else .replace
  else .replace

/--
The row to write before acting on a node the state already has a row for. A row
whose status is not `ready` records a step that began and did not finish, and
is carried on from where it stopped.
-/
def carry (ps : Providers K api) (node : Node K) (r : Row K) : Row K :=
  match diffRow ps r node, r.status with
  | .replace, _ => .of node (r.generation + 1) .replacing (r.current :: r.old)
  | .noop, .ready => .of node r.generation .ready r.old
  | _, .ready => .of node r.generation .updating r.old
  | _, .updating => .of node r.generation .updating r.old
  | _, .creating => .of node r.generation .creating r.old
  | _, .replacing => .of node r.generation .replacing r.old
  | _, .deleting => .of node r.generation .creating r.old

/-- The row to write before acting on a node, given what the state holds. -/
def intend (ps : Providers K api) (node : Node K) : Option (Row K) → Row K
  | none => .of node 0 .creating []
  | some r => carry ps node r

theorem diffRow_same {ps : Providers K api} {r : Row K} {node : Node K}
    (h : diffRow ps r node ≠ .replace) : r.kind = node.kind ∧ r.id = node.id := by
  unfold diffRow at h
  split at h
  · split at h
    · exact ⟨‹_›, ‹_›⟩
    · exact absurd rfl h
  · exact absurd rfl h

/-- The row written for a node tracks everything the row before it did. -/
theorem carry_tracks (ps : Providers K api) (node : Node K) (r : Row K) (y : Physical K)
    (t : r.tracks y) : (carry ps node r).tracks y := by
  have same (generation status) (h : diffRow ps r node ≠ .replace) :
      (Row.of node generation status r.old).tracks y ↔
        (y = ⟨r.kind, r.id, generation⟩ ∨ y ∈ r.old) := by
    obtain ⟨kind, id⟩ := diffRow_same h
    simp [Row.tracks, Row.of, Row.current, Node.id] at *
    simp [kind, id]
  have here : y = ⟨r.kind, r.id, r.generation⟩ ∨ y ∈ r.old := t
  unfold carry
  split
  · rcases t with eq | mem
    · exact .inr (by simp [Row.of, eq])
    · exact .inr (by simp [Row.of, mem])
  all_goals exact (same _ _ (by simp_all)).2 here

/-- What the engine would do to a node. -/
inductive Action where
  | create
  | update
  | replace
  | noop
  | delete
deriving DecidableEq, Repr

def planNode (ps : Providers K api) (node : Node K) (row : Option (Row K)) : Action :=
  match row with
  | none => .create
  | some r =>
    match (intend ps node (some r)).status with
    | .creating => .create
    | .updating => .update
    | .replacing => .replace
    | .ready => if r.old.isEmpty then .noop else .update
    | .deleting => .delete

/-- What applying a graph to a state would do, without doing it. -/
def plan (ps : Providers K api) (g : Graph K) (s : State K) : List (String × Action) :=
  (g.order.filterMap fun id => (g.find id).map fun node => (id, planNode ps node (s.row id)))
    ++ ((s.ids.filter fun id => !g.ids.contains id && (s.row id).isSome).eraseDups.map (·, .delete))

/-- A resource that is ready, as the graph describes it, needs nothing. -/
theorem planNode_settled (ps : Providers K api) (law : Lawful ps m) (node : Node K) (generation : Nat) :
    planNode ps node (some (.of node generation .ready [])) = .noop := by
  have : diffRow ps (.of node generation .ready []) node = .noop := by
    simp [diffRow, Row.of, law.diff_self]
  have carried : carry ps node (.of node generation .ready []) = .of node generation .ready [] := by
    unfold carry; rw [this]; rfl
  simp only [planNode, intend]
  rw [carried]
  simp [Row.of]

/-! ## Apply -/

/-- Remove the instances a row replaced, oldest decision first, forgetting each once it is gone. -/
def collect (ps : Providers K api) (m : Model api) (id : String) (r : Row K) :
    List (Physical K) → World K m → World K m × Bool
  | [], w => (w, true)
  | y :: rest, w =>
    let out := deleted ps m y w.cloud
    match out.1 with
    | .ok () => collect ps m id r rest ⟨w.state.set id { r with old := rest }, out.2⟩
    | .error _ => (⟨w.state, out.2⟩, false)

/-- Bring one node of the graph into being. -/
def converge (ps : Providers K api) (m : Model api) (node : Node K) (w : World K m) :
    World K m × Bool :=
  let r := intend ps node (w.state.row node.id)
  let w₁ : World K m := ⟨w.state.set node.id r, w.cloud⟩
  if r.status = .ready then collect ps m node.id r r.old w₁
  else
    let out := reconciled ps m r w₁.cloud
    match out.1 with
    | .error _ => (⟨w₁.state, out.2⟩, false)
    | .ok _ =>
      let ready := { r with status := .ready }
      collect ps m node.id ready ready.old ⟨w₁.state.set node.id ready, out.2⟩

/-- Remove a resource the graph no longer has. -/
def destroy (ps : Providers K api) (m : Model api) (id : String) (w : World K m) :
    World K m × Bool :=
  match w.state.row id with
  | none => (w, true)
  | some r =>
    let leaving := { r with status := .deleting }
    let collected := collect ps m id leaving leaving.old ⟨w.state.set id leaving, w.cloud⟩
    if collected.2 then
      let out := deleted ps m r.current collected.1.cloud
      match out.1 with
      | .ok () => (⟨collected.1.state.erase id, out.2⟩, true)
      | .error _ => (⟨collected.1.state, out.2⟩, false)
    else (collected.1, false)

/-- Run `step` for each id in turn, and say whether every one succeeded. -/
def each (step : String → World K m → World K m × Bool) : List String → World K m → World K m × Bool
  | [], w => (w, true)
  | id :: rest, w => ((each step rest (step id w).1).1, (step id w).2 && (each step rest (step id w).1).2)

/-- Bring into being the node with this id, if the graph has one. -/
def convergeId (ps : Providers K api) (m : Model api) (g : Graph K) (id : String) (w : World K m) :
    World K m × Bool :=
  match g.find id with
  | some node => converge ps m node w
  | none => (w, true)

/--
Make the cloud match the graph: bring every node into being in dependency
order, then remove what the graph no longer has. Nothing is removed unless
everything before it succeeded.
-/
def apply (ps : Providers K api) (m : Model api) (g : Graph K) (w : World K m) : World K m × Bool :=
  let converged := each (convergeId ps m g) g.order w
  if converged.2 = true then
    each (destroy ps m) (converged.1.state.ids.filter fun id => !g.ids.contains id).eraseDups converged.1
  else converged

/-! ## Apply takes only steps -/

theorem State.tracks_erase {s : State K} {id : String} {z : Physical K}
    (h : s.tracks z) (elsewhere : ∀ r, s.row id = some r → ¬ r.tracks z) : (s.erase id).tracks z := by
  obtain ⟨i, r, at_, t⟩ := h
  by_cases eq : i = id
  · subst eq; exact absurd t (elsewhere r at_)
  · exact ⟨i, r, by simp [State.erase, eq, at_], t⟩

theorem collect_steps (ps : Providers K api) (id : String) (r : Row K) (olds : List (Physical K))
    (w : World K m) (has : w.state.row id = some { r with old := olds }) :
    Steps ps m w (collect ps m id r olds w).1 := by
  induction olds generalizing w with
  | nil => exact .done w
  | cons y rest ih =>
    have tracked : w.state.tracks y := ⟨id, _, has, .inr (by simp)⟩
    simp only [collect]
    split
    · next ok =>
      refine .trans (.next (.done w) (.delete y tracked ?_)) (ih _ (by simp))
      intro z t why
      have ne : z ≠ y := why.resolve_right (by simp [ok])
      obtain ⟨i, r₀, at_, t⟩ := t
      by_cases eq : i = id
      · subst eq
        rw [has] at at_
        cases at_
        refine ⟨i, _, State.set_row_self _ _ _, ?_⟩
        rcases t with cur | mem
        · exact .inl cur
        · exact .inr (by simpa [ne] using mem)
      · exact ⟨i, r₀, by rw [State.set_row_of_ne _ _ eq]; exact at_, t⟩
    · exact .next (.done w) (.delete y tracked fun z t _ => t)

/-- Once every replaced instance is gone, the row has none left; other rows are untouched. -/
theorem collect_row (ps : Providers K api) (id : String) (r : Row K) (olds : List (Physical K))
    (w : World K m) (has : w.state.row id = some { r with old := olds }) :
    ((collect ps m id r olds w).2 = true →
        (collect ps m id r olds w).1.state.row id = some { r with old := [] }) ∧
      ∀ other, other ≠ id → (collect ps m id r olds w).1.state.row other = w.state.row other := by
  induction olds generalizing w with
  | nil => exact ⟨fun _ => has, fun _ _ => rfl⟩
  | cons y rest ih =>
    simp only [collect]
    split
    · obtain ⟨row, others⟩ := ih ⟨w.state.set id { r with old := rest }, _⟩ (by simp)
      exact ⟨row, fun other ne => by rw [others other ne]; exact State.set_row_of_ne _ _ ne⟩
    · exact ⟨fun h => by simp at h, fun _ _ => rfl⟩

theorem converge_steps (ps : Providers K api) (node : Node K) (w : World K m) :
    Steps ps m w (converge ps m node w).1 := by
  have write : ∀ y, w.state.tracks y →
      (w.state.set node.id (intend ps node (w.state.row node.id))).tracks y := by
    intro y t
    refine State.tracks_set (fun r at_ z tz => ?_) t
    rw [at_]
    exact carry_tracks ps node r z tz
  simp only [converge]
  split
  · exact .trans (.next (.done w) (.write write)) (collect_steps ps _ _ _ _ (by simp))
  · split
    · exact .next (.next (.done w) (.write write))
        (.reconcile node.id _ (State.set_row_self _ _ _) fun _ t => t)
    · refine .trans (.next (.next (.done w) (.write write))
        (.reconcile node.id _ (State.set_row_self _ _ _) ?_)) (collect_steps ps _ _ _ _ (by simp))
      intro y t
      exact State.tracks_set (fun r at_ z tz => by simp at at_; subst at_; exact tz) t

theorem destroy_steps (ps : Providers K api) (id : String) (w : World K m) :
    Steps ps m w (destroy ps m id w).1 := by
  unfold destroy
  split
  · exact .done w
  · next r has =>
    have write : ∀ y, w.state.tracks y →
        (w.state.set id { r with status := .deleting }).tracks y :=
      fun y t => State.tracks_set (fun r₀ at_ z tz => by rw [has] at at_; cases at_; exact tz) t
    have collected := collect_steps ps id { r with status := .deleting } r.old
      ⟨w.state.set id { r with status := .deleting }, w.cloud⟩ (by simp)
    have rows := collect_row (m := m) ps id { r with status := .deleting } r.old
      ⟨w.state.set id { r with status := .deleting }, w.cloud⟩ (by simp)
    have steps := Steps.next (.done w) (.write (ps := ps) write) |>.trans collected
    simp only []
    split
    · next done =>
      have row := rows.1 done
      have tracked : (collect ps m id { r with status := .deleting } r.old
          ⟨w.state.set id { r with status := .deleting }, w.cloud⟩).1.state.tracks r.current :=
        ⟨id, _, row, .inl rfl⟩
      split
      · next ok =>
        refine .next steps (.delete r.current tracked ?_)
        intro z t why
        have ne : z ≠ r.current := why.resolve_right (by simp [ok])
        refine State.tracks_erase t fun r₀ at_ tz => ?_
        rw [row] at at_
        cases at_
        rcases tz with cur | mem
        · exact ne cur
        · simp at mem
      · exact .next steps (.delete r.current tracked fun z t _ => t)
    · exact steps

theorem each_steps (ps : Providers K api) (step : String → World K m → World K m × Bool)
    (sound : ∀ id w, Steps ps m w (step id w).1) (ids : List String) (w : World K m) :
    Steps ps m w (each step ids w).1 := by
  induction ids generalizing w with
  | nil => exact .done w
  | cons id rest ih => exact .trans (sound id w) (ih _)

/-- Everything `apply` does is a step. -/
theorem apply_steps (ps : Providers K api) (g : Graph K) (w : World K m) :
    Steps ps m w (apply ps m g w).1 := by
  have converged := each_steps ps (convergeId ps m g)
    (fun id w => by unfold convergeId; split; exact converge_steps ps _ w; exact .done w) g.order w
  unfold apply
  by_cases ok : (each (convergeId ps m g) g.order w).2 = true
  · simp only [ok, ite_true]
    exact .trans converged (each_steps ps _ (destroy_steps ps) _ _)
  · simp only [ok]
    exact converged

/--
**Apply leaks nothing.** For any graph, any state and any lawful providers,
whatever fails and wherever it stops: if every resource in the cloud was
tracked before, every resource in the cloud is tracked after.
-/
theorem apply_tracked {ps : Providers K api} (law : Lawful ps m) (g : Graph K) (w : World K m)
    (h : Tracked law w) : Tracked law (apply ps m g w).1 :=
  (apply_steps ps g w).tracked law h

/-! ## A successful apply leaves exactly the graph -/

theorem intend_form (ps : Providers K api) (node : Node K) (row : Option (Row K)) :
    ∃ generation status old, intend ps node row = .of node generation status old := by
  cases row with
  | none => exact ⟨_, _, _, rfl⟩
  | some r => simp only [intend, carry]; split <;> exact ⟨_, _, _, rfl⟩

/-- A node is settled when its row says it is ready, as the graph describes it, with nothing left to remove. -/
def Settled (node : Node K) (s : State K) : Prop :=
  ∃ generation, s.row node.id = some (.of node generation .ready [])

theorem converge_others (ps : Providers K api) (node : Node K) (w : World K m) (other : String)
    (ne : other ≠ node.id) : (converge ps m node w).1.state.row other = w.state.row other := by
  simp only [converge]
  split
  · rw [(collect_row ps _ _ _ _ (by simp)).2 other ne]; exact State.set_row_of_ne _ _ ne
  · split
    · exact State.set_row_of_ne _ _ ne
    · rw [(collect_row ps _ _ _ _ (by simp)).2 other ne]
      simp [State.set_row_of_ne _ _ ne]

theorem converge_settled (ps : Providers K api) (node : Node K) (w : World K m)
    (ok : (converge ps m node w).2 = true) : Settled node (converge ps m node w).1.state := by
  obtain ⟨generation, status, old, form⟩ := intend_form ps node (w.state.row node.id)
  simp only [converge] at ok ⊢
  rw [form] at ok ⊢
  split at ok
  · next ready =>
    simp only [Row.of] at ready
    subst ready
    split
    · exact ⟨generation, (collect_row ps _ _ _ _ (by simp)).1 ok⟩
    · next h => exact absurd rfl h
  · next notReady =>
    simp only [notReady, ite_false]
    cases out : (reconciled ps m (Row.of node generation status old) w.cloud).1 with
    | error e => simp [out] at ok
    | ok attrs =>
      simp only [out] at ok ⊢
      exact ⟨generation, (collect_row ps _ _ _ _ (by simp)).1 ok⟩

theorem destroy_others (ps : Providers K api) (id : String) (w : World K m) (other : String)
    (ne : other ≠ id) : (destroy ps m id w).1.state.row other = w.state.row other := by
  unfold destroy
  split
  · rfl
  · next r has =>
    have rows := (collect_row (m := m) ps id { r with status := .deleting } r.old
      ⟨w.state.set id { r with status := .deleting }, w.cloud⟩ (by simp)).2 other ne
    simp only []
    split
    · split
      · simp only [State.erase, ne, ite_false]
        rw [rows]; exact State.set_row_of_ne _ _ ne
      · rw [rows]; exact State.set_row_of_ne _ _ ne
    · rw [rows]; exact State.set_row_of_ne _ _ ne

theorem destroy_gone (ps : Providers K api) (id : String) (w : World K m)
    (ok : (destroy ps m id w).2 = true) : (destroy ps m id w).1.state.row id = none := by
  cases has : w.state.row id with
  | none => simp only [destroy, has]
  | some r =>
    simp only [destroy, has] at ok ⊢
    split at ok
    · next collected =>
      simp only [collected, ite_true]
      split at ok
      · simp [State.erase]
      · simp at ok
    · simp at ok

/-- What `each` establishes for the ids it ran, and what it leaves alone. -/
theorem each_keeps (step : String → World K m → World K m × Bool) (P : World K m → Prop)
    (ids : List String) (keep : ∀ id ∈ ids, ∀ w, P w → P (step id w).1) (w : World K m) (h : P w) :
    P (each step ids w).1 := by
  induction ids generalizing w with
  | nil => exact h
  | cons id rest ih =>
    exact ih (fun i mem => keep i (List.mem_cons_of_mem _ mem)) _ (keep id (List.mem_cons_self) w h)

theorem each_all (step : String → World K m → World K m × Bool) (P : String → World K m → Prop)
    (establish : ∀ id w, (step id w).2 = true → P id (step id w).1)
    (keep : ∀ id other w, other ≠ id → P id w → P id (step other w).1)
    (ids : List String) (w : World K m) (ok : (each step ids w).2 = true) :
    ∀ id ∈ ids, P id (each step ids w).1 := by
  induction ids generalizing w with
  | nil => intro _ mem; cases mem
  | cons head rest ih =>
    simp only [each, Bool.and_eq_true] at ok
    intro id mem
    by_cases later : id ∈ rest
    · exact ih _ ok.2 id later
    · have eq : id = head := by
        rcases List.mem_cons.1 mem with h | h
        · exact h
        · exact absurd h later
      subst eq
      refine each_keeps step (P id) rest (fun other mem' w' h => ?_) _ (establish id w ok.1)
      exact keep id other w' (fun e => later (e ▸ mem')) h

theorem find_id {g : Graph K} {id : String} {node : Node K} (h : g.find id = some node) :
    node.id = id := by
  have := List.find?_some h
  simpa using this

/--
**A successful apply leaves the state matching the graph.** Every node the
graph can order is settled, and nothing the graph does not have keeps a row.
It holds from any starting state, so it holds after any earlier crash.
-/
theorem apply_settles (ps : Providers K api) (g : Graph K) (w : World K m)
    (ok : (apply ps m g w).2 = true) :
    (∀ id ∈ g.order, ∀ node, g.find id = some node → Settled node (apply ps m g w).1.state) ∧
      ∀ id, id ∉ g.ids → (apply ps m g w).1.state.row id = none := by
  unfold apply at ok ⊢
  by_cases first : (each (convergeId ps m g) g.order w).2 = true
  · simp only [first, ite_true] at ok ⊢
    have settled := each_all (convergeId ps m g)
      (fun id w => ∀ node, g.find id = some node → Settled node w.state)
      (fun id w ok node found => by
        simp only [convergeId, found] at ok ⊢
        exact converge_settled ps node w ok)
      (fun id other w ne h node found => by
        obtain ⟨generation, row⟩ := h node found
        refine ⟨generation, ?_⟩
        rw [← row]
        unfold convergeId
        split
        · next n foundOther =>
          exact converge_others ps n w node.id (by rw [find_id found, find_id foundOther]; exact ne.symm)
        · rfl)
      g.order w first
    generalize each (convergeId ps m g) g.order w = mid at settled ok ⊢
    have gone := each_all (destroy ps m) (fun id w => w.state.row id = none)
      (destroy_gone ps)
      (fun id other w ne h => by rw [destroy_others ps other w id ne.symm]; exact h)
      _ mid.1 ok
    constructor
    · intro id inOrder node found
      refine each_keeps (destroy ps m) (fun w => Settled node w.state) _ (fun other mem w' h => ?_) _
        (settled id inOrder node found)
      obtain ⟨generation, row⟩ := h
      refine ⟨generation, ?_⟩
      rw [← row]
      refine destroy_others ps other w' node.id fun same => ?_
      have notInGraph : other ∉ g.ids := by
        have := List.mem_filter.1 (List.mem_eraseDups.1 mem)
        simpa using this.2
      exact notInGraph (by
        rw [← same]
        have := List.mem_of_find?_eq_some found
        exact List.mem_map_of_mem (f := Node.id) this)
    · intro id notInGraph
      by_cases has : mid.1.state.row id = none
      · exact each_keeps (destroy ps m) (fun w => w.state.row id = none) _
          (fun other _ w' h => by
            by_cases same : id = other
            · subst same
              unfold destroy
              rw [h]
              exact h
            · rw [destroy_others ps other w' id same]; exact h) _ has
      · exact gone id (List.mem_eraseDups.2 (List.mem_filter.2
          ⟨mid.1.state.listed id has, by simpa using notInGraph⟩))
  · simp [first] at ok

theorem find_of_mem_ids {g : Graph K} {id : String} (h : id ∈ g.ids) : ∃ node, g.find id = some node := by
  obtain ⟨node, mem, rfl⟩ := List.mem_map.1 h
  cases found : g.find node.id with
  | some n => exact ⟨n, rfl⟩
  | none =>
    have := List.find?_eq_none.1 found node mem
    simp at this

/--
**A successful apply leaves the cloud holding the graph and nothing else.**
If every existing resource was tracked before, then after an apply that
succeeds, every resource that exists is the current instance of a node of the
graph. Nothing from an earlier configuration, an earlier replacement or an
earlier crash is left behind.
-/
theorem apply_exact {ps : Providers K api} (law : Lawful ps m) (g : Graph K) (w : World K m)
    (tracked : Tracked law w) (ordered : ∀ id ∈ g.ids, id ∈ g.order)
    (ok : (apply ps m g w).2 = true) (y : Physical K)
    (present : law.present y (apply ps m g w).1.cloud = true) :
    ∃ node, g.find y.id = some node ∧ y.kind = node.kind := by
  obtain ⟨settled, gone⟩ := apply_settles ps g w ok
  obtain ⟨id, r, at_, t⟩ := apply_tracked law g w tracked y present
  by_cases inGraph : id ∈ g.ids
  · obtain ⟨node, found⟩ := find_of_mem_ids inGraph
    obtain ⟨generation, row⟩ := settled id (ordered id inGraph) node found
    rw [find_id found] at row
    rw [row] at at_
    cases at_
    rcases t with cur | old
    · subst cur
      exact ⟨node, by simpa [Row.current, Row.of, find_id found] using found, rfl⟩
    · simp [Row.of] at old
  · rw [gone id inGraph] at at_
    cases at_

end Alchemy.Cloud
