import Alchemy.Cloud.AWS
import Alchemy.Cloud.Hosted

/-!
# A journal in S3

Where a hosted model keeps its history on AWS.
-/

namespace Alchemy.AWS.S3
open Alchemy.Cloud

/--
A journal kept in a bucket: one object a line, numbered, under a prefix. Grants
listing the bucket, and reading and writing under that prefix.
-/
def JournalLive (bucket : AWS.Bucket) (under : Path := ["journal"]) : Layer Nothing (Journal (K := Kind)) :=
  .from (ListObjectsLive bucket ++ GetObjectLive bucket under ++ PutObjectLive bucket under) do
    let objects ← ListObjects bucket
    let reader ← GetObject bucket under
    let writer ← PutObject bucket under
    let count : Run _ Never Nat := do
      return ((← objects.call).filter (under.isPrefixOf ·)).length
    return {
      read := do
        let mut lines := []
        for line in _root_.List.range (← count) do
          match ← (reader.call (toString line)).result with
          | .ok text => lines := lines ++ [text]
          | .error _ => pure ()
        return lines
      append := fun text => do writer.call (toString (← count)) text }

/-- A journal in a bucket: a step of a host's block. -/
def Journal {role : Access Kind} (bucket : AWS.Bucket) (under : Path := ["journal"]) :
    Host role (Cloud.Journal role) :=
  Host.provide (JournalLive bucket under)

end Alchemy.AWS.S3

namespace Alchemy.AWS
open Alchemy.Cloud

/-! ## Requests, in a story -/

/-- A request on its way to a function, in a story. -/
structure Asked where
  function : AWS.Function
  request : Request

def pathOf (path : String) : Path := (path.splitOn "/").filter (· ≠ "")

/-- `get api "/orders/o-1"` -/
def get (function : AWS.Function) (path : String) : Asked :=
  ⟨function, { method := .get, path := pathOf path }⟩

/-- `post api "/orders/o-1" body`: the body is sent as JSON. -/
def post {α : Type} [Text α] (function : AWS.Function) (path : String) (body : α) : Asked :=
  ⟨function, { method := .post, path := pathOf path, body := Text.write body }⟩

/-- `get api "/revenue" ⇒ (200, "40")`: the request, and the status and body it must get. -/
def Asked.answers (asked : Asked) (expected : Nat × String) : Graph.Step Kind InMemory :=
  .request asked.function asked.request (responds { status := expected.1, body := expected.2 })

@[inherit_doc] infix:50 " ⇒ " => Asked.answers

end Alchemy.AWS
