import Lean

/-!
The definitions a behaviour proof steps through: the engine's, and each
model's own.
-/

/-- Unfolded when a behaviour theorem is proved by running the model with its variables left as they are. -/
register_simp_attr behaviour

/-- Facts a rule about a stack is checked with: what the stack built, and how grants cover one another. -/
register_simp_attr stack_facts
