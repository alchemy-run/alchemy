import Lean

/-!
The definitions a behaviour proof steps through: the engine's, and each
model's own.
-/

/-- Unfolded when a behaviour theorem is proved by running the model with its variables left as they are. -/
register_simp_attr behaviour
