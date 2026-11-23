import Alchemy.Signature

/-!
What a policy or a saga does, as data: send a command, call an outside system,
wait for a signal, register how to undo a step. Because it is data, the model
can say exactly when each step runs, and a proof can follow it.
-/
namespace Alchemy

inductive Program (σ : Signature) (α : Type) where
  | pure (a : α)
  /-- Stop: the steps registered with `compensate` are undone, newest first. -/
  | fail (failure : σ.Failure)
  /-- Send a command, and go on with its answer. -/
  | send (s : Send σ.aggregates) (k : Answer σ.aggregates s.to → Program σ α)
  /-- Call an outside system, and go on with whatever it answers. -/
  | call (c : σ.Call) (k : σ.Reply c → Program σ α)
  /-- Wait for the next signal sent to this run. -/
  | await (k : σ.Signal → Program σ α)
  /-- Register a command to send if the program later fails, given how it failed. -/
  | compensate (undo : σ.Failure → Send σ.aggregates) (k : Program σ α)
  /-- Start a saga's run. A run already started is left alone. -/
  | start (saga : σ.Saga) (input : σ.SagaInput) (k : Program σ α)
  /-- Tell a saga's run something. -/
  | signal (saga : σ.Saga) (signal : σ.Signal) (k : Program σ α)
  /-- Send a command later. -/
  | schedule (after : Time) (s : Send σ.aggregates) (k : Program σ α)

namespace Program

variable {σ : Signature} {α β : Type}

def bind : Program σ α → (α → Program σ β) → Program σ β
  | .pure a, f => f a
  | .fail e, _ => .fail e
  | .send s k, f => .send s fun r => (k r).bind f
  | .call c k, f => .call c fun r => (k r).bind f
  | .await k, f => .await fun r => (k r).bind f
  | .compensate u k, f => .compensate u (k.bind f)
  | .start s i k, f => .start s i (k.bind f)
  | .signal s x k, f => .signal s x (k.bind f)
  | .schedule t s k, f => .schedule t s (k.bind f)

instance : Monad (Program σ) where
  pure := .pure
  bind := bind

/-- Send a command and go on, whatever it answers. -/
def tell (s : Send σ.aggregates) : Program σ Unit :=
  .send s fun _ => .pure ()

/-- Send a command; a rejection fails the program with what `explain` makes of it. -/
def step (s : Send σ.aggregates)
    (explain : (σ.aggregates.of s.to).Rejection → σ.Failure) : Program σ Unit :=
  .send s fun
    | .ok _ => .pure ()
    | .error r => .fail (explain r)

/-- Send a command and have its answer. -/
def ask (s : Send σ.aggregates) : Program σ (Answer σ.aggregates s.to) :=
  .send s .pure

/-- Call an outside system. -/
def request (c : σ.Call) : Program σ (σ.Reply c) :=
  .call c .pure

/-- Wait for the next signal. -/
def awaitSignal : Program σ σ.Signal :=
  .await .pure

/-- From here on, a failure sends `undo`, given how the program failed. -/
def undoWith (undo : σ.Failure → Send σ.aggregates) : Program σ Unit :=
  .compensate undo (.pure ())

def startSaga (saga : σ.Saga) (input : σ.SagaInput) : Program σ Unit :=
  .start saga input (.pure ())

def signalSaga (saga : σ.Saga) (signal : σ.Signal) : Program σ Unit :=
  .signal saga signal (.pure ())

def later (after : Time) (s : Send σ.aggregates) : Program σ Unit :=
  .schedule after s (.pure ())

end Program
end Alchemy
