/-!
# Access

Access is a typed expression: an operation on a resource, or two expressions
together. What it means is the set of attempts it permits, and rules about
access are proved against that meaning.
-/

namespace Alchemy.Cloud

/-- A resource of one kind, named by its logical id. -/
structure Ref {K : Type} (kind : K) where
  id : String
deriving DecidableEq, Repr

/-- The kinds of resource a cloud has, and the operations each kind allows. -/
class Kinds (K : Type) where
  /-- The operations that can be granted on a resource of this kind. -/
  Op : K → Type
  /-- Whether a grant of the first operation also allows the second. A grant always allows itself. -/
  covers : {k : K} → Op k → Op k → Bool := fun _ _ => false
  decKind : DecidableEq K := by infer_instance
  decOp : (k : K) → DecidableEq (Op k) := by infer_instance

set_option warn.classDefReducibility false in
attribute [instance] Kinds.decKind Kinds.decOp

variable {K : Type} [Kinds K]

/-- One thing a principal might try: an operation on a resource. -/
structure Attempt (K : Type) [Kinds K] where
  kind : K
  ref : Ref kind
  op : Kinds.Op kind

/-- An expression of access. -/
inductive Access (K : Type) [Kinds K] where
  /-- No access. -/
  | none
  /-- One operation on one resource. -/
  | on {k : K} (ref : Ref k) (op : Kinds.Op k)
  /-- Both. -/
  | and (a b : Access K)

instance : Union (Access K) := ⟨.and⟩
instance : EmptyCollection (Access K) := ⟨.none⟩

/-- Whether a grant of `op` on `ref` permits an attempt. -/
def permitsOn {k : K} (ref : Ref k) (op : Kinds.Op k) (t : Attempt K) : Bool :=
  if h : t.kind = k then
    ref.id == t.ref.id && (op == (h ▸ t.op) || Kinds.covers op (h ▸ t.op))
  else false

/-- What an expression means: the attempts it permits. -/
def Access.permits : Access K → Attempt K → Bool
  | .none, _ => false
  | .on ref op, t => permitsOn ref op t
  | .and a b, t => a.permits t || b.permits t

/-- The grants an expression is made of. -/
def Access.atoms : Access K → List (Attempt K)
  | .none => []
  | .on ref op => [⟨_, ref, op⟩]
  | .and a b => a.atoms ++ b.atoms

/-- Every grant in a list. -/
def Access.all (grants : List (Access K)) : Access K := grants.foldr (· ∪ ·) ∅

@[simp] theorem Access.permits_none (t : Attempt K) : (∅ : Access K).permits t = false := rfl

@[simp] theorem Access.permits_union (a b : Access K) (t : Attempt K) :
    (a ∪ b).permits t = (a.permits t || b.permits t) := rfl

@[simp] theorem Access.permits_on {k : K} (ref ref' : Ref k) (op op' : Kinds.Op k) :
    (Access.on ref op).permits ⟨k, ref', op'⟩
      = (ref.id == ref'.id && (op == op' || Kinds.covers op op')) := by
  simp [Access.permits, permitsOn]

/-- A grant permits the very thing it grants. -/
theorem Access.permits_self {k : K} (ref : Ref k) (op : Kinds.Op k) :
    (Access.on ref op).permits ⟨k, ref, op⟩ = true := by
  simp

/-- An expression permits an attempt exactly when one of its grants does. -/
theorem Access.permits_iff_atom (a : Access K) (t : Attempt K) :
    a.permits t = true ↔ ∃ g ∈ a.atoms, permitsOn g.ref g.op t = true := by
  induction a with
  | none => simp [Access.permits, Access.atoms]
  | on ref op => simp [Access.permits, Access.atoms]
  | and a b iha ihb =>
    simp only [Access.permits, Access.atoms, Bool.or_eq_true, iha, ihb, List.mem_append]
    constructor
    · rintro (⟨g, m, h⟩ | ⟨g, m, h⟩)
      · exact ⟨g, .inl m, h⟩
      · exact ⟨g, .inr m, h⟩
    · rintro ⟨g, m | m, h⟩
      · exact .inl ⟨g, m, h⟩
      · exact .inr ⟨g, m, h⟩

/-- `a ≤ b`: `a` grants no more than `b`. -/
instance : LE (Access K) := ⟨fun a b => ∀ t, a.permits t = true → b.permits t = true⟩

theorem Access.le_refl (a : Access K) : a ≤ a := fun _ h => h

theorem Access.le_trans {a b c : Access K} (ab : a ≤ b) (bc : b ≤ c) : a ≤ c :=
  fun t h => bc t (ab t h)

theorem Access.le_union_left (a b : Access K) : a ≤ a ∪ b := fun t h => by simp [h]

theorem Access.le_union_right (a b : Access K) : b ≤ a ∪ b := fun t h => by simp [h]

theorem Access.union_le {a b c : Access K} (ac : a ≤ c) (bc : b ≤ c) : a ∪ b ≤ c := by
  intro t h
  simp only [Access.permits_union, Bool.or_eq_true] at h
  exact h.elim (ac t) (bc t)

theorem Access.none_le (a : Access K) : (∅ : Access K) ≤ a := fun t h => by simp at h

/--
`Has access need`: `access` includes `need`. Instances find it by the shape of
the expression, so it works for resources that are still variables.
-/
class Has (access need : Access K) : Prop where
  le : need ≤ access

instance (a : Access K) : Has a a := ⟨Access.le_refl a⟩

instance (a b need : Access K) [h : Has a need] : Has (a ∪ b) need :=
  ⟨Access.le_trans h.le (Access.le_union_left a b)⟩

instance (a b need : Access K) [h : Has b need] : Has (a ∪ b) need :=
  ⟨Access.le_trans h.le (Access.le_union_right a b)⟩

instance (a m n : Access K) [hm : Has a m] [hn : Has a n] : Has a (m ∪ n) :=
  ⟨Access.union_le hm.le hn.le⟩

instance (a : Access K) : Has a ∅ := ⟨Access.none_le a⟩

/-- Access that includes a grant permits whatever that grant covers. -/
theorem Has.permits_covered {access : Access K} {k : K} {ref : Ref k} {granted op : Kinds.Op k}
    (h : Has access (.on ref granted)) (covered : (granted == op || Kinds.covers granted op) = true) :
    access.permits ⟨k, ref, op⟩ = true :=
  h.le _ (by simp [covered])

/-- Access that includes a grant permits what it grants. -/
theorem Has.permits {access : Access K} {k : K} {ref : Ref k} {op : Kinds.Op k}
    (h : Has access (.on ref op)) : access.permits ⟨k, ref, op⟩ = true :=
  h.le _ (Access.permits_self ref op)

end Alchemy.Cloud
