import Alchemy.Cloud.Sim

/-!
# Reasoning about code that runs

`Run.eval` is what a piece of code answers and the cloud it leaves. The lemmas
here step through code one call at a time, so a law about a binding, or a
theorem about code built on bindings, is proved without running anything.
-/

namespace Alchemy.Cloud

variable {K : Type} [Cloud K] {access : Access K} {ε ε' α β : Type}

namespace Run

/-- What running code answers, and the cloud it leaves. -/
def eval (sim : Sim K) (run : Run access ε α) (s : sim.State) : Except ε α × sim.State :=
  ((run.exec sim s).result, (run.exec sim s).state)

variable (sim : Sim K)

@[simp] theorem eval_pure (a : α) (s : sim.State) :
    (Run.pure a : Run access ε α).eval sim s = (.ok a, s) := rfl

@[simp] theorem eval_pure' (a : α) (s : sim.State) :
    (pure a : Run access ε α).eval sim s = (.ok a, s) := rfl

@[simp] theorem eval_fail (e : ε) (s : sim.State) :
    (Run.fail e : Run access ε α).eval sim s = (.error e, s) := rfl

@[simp] theorem eval_call {k : K} (ref : Ref k) (c : Cloud.Call k) (ok)
    (next : Cloud.Reply c → Run access ε α) (s : sim.State) :
    (Run.call ref c ok next).eval sim s = (next (sim.call ref c s).1).eval sim (sim.call ref c s).2.1 :=
  rfl

/-- One call: what the cloud answers, and the cloud it leaves. -/
@[simp] theorem eval_perform {k : K} (ref : Ref k) (c : Cloud.Call k) (h) (s : sim.State) :
    (Run.perform ref c h : Run access ε _).eval sim s = (.ok (sim.call ref c s).1, (sim.call ref c s).2.1) :=
  rfl

@[simp] theorem eval_performUnder {k : K} (ref : Ref k) (c : Cloud.Call k) (granted) (h) (covered)
    (s : sim.State) :
    (Run.performUnder ref c granted h covered : Run access ε _).eval sim s
      = (.ok (sim.call ref c s).1, (sim.call ref c s).2.1) :=
  rfl

/-- Two steps in a row: the second runs in the cloud the first left. -/
theorem eval_bind (x : Run access ε α) (f : α → Run access ε β) (s : sim.State) :
    (x.bind f).eval sim s =
      match (x.eval sim s).1 with
      | .ok a => (f a).eval sim (x.eval sim s).2
      | .error e => (.error e, (x.eval sim s).2) := by
  induction x generalizing s with
  | pure a => rfl
  | fail e => rfl
  | call ref c ok next ih => exact ih _ _

theorem eval_bind' (x : Run access ε α) (f : α → Run access ε β) (s : sim.State) :
    (x >>= f).eval sim s =
      match (x.eval sim s).1 with
      | .ok a => (f a).eval sim (x.eval sim s).2
      | .error e => (.error e, (x.eval sim s).2) :=
  eval_bind sim x f s

theorem eval_recover (x : Run access ε α) (f : ε → Run access ε' α) (s : sim.State) :
    (x.recover f).eval sim s =
      match (x.eval sim s).1 with
      | .ok a => (.ok a, (x.eval sim s).2)
      | .error e => (f e).eval sim (x.eval sim s).2 := by
  induction x generalizing s with
  | pure a => rfl
  | fail e => rfl
  | call ref c ok next ih => exact ih _ _

theorem eval_mapError (g : ε → ε') (x : Run access ε α) (s : sim.State) :
    (x.mapError g).eval sim s = ((x.eval sim s).1.mapError g, (x.eval sim s).2) := by
  unfold mapError
  rw [eval_recover]
  cases (x.eval sim s).1 <;> rfl

theorem eval_result (x : Run access ε α) (s : sim.State) :
    (x.result : Run access ε' _).eval sim s = (.ok (x.eval sim s).1, (x.eval sim s).2) := by
  unfold result
  rw [eval_recover, eval_bind]
  cases (x.eval sim s).1 <;> rfl

/-- Code that cannot fail answers. -/
theorem eval_never (x : Run access Never α) (s : sim.State) : ∃ a, (x.eval sim s).1 = .ok a := by
  induction x generalizing s with
  | pure a => exact ⟨a, rfl⟩
  | fail e => exact nomatch e
  | call ref c ok next ih => exact ih _ _

end Run

end Alchemy.Cloud
