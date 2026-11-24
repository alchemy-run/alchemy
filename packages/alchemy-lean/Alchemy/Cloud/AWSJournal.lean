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
    let objects ← service (ListObjects bucket)
    let reader ← service (GetObject bucket under)
    let writer ← service (PutObject bucket under)
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

end Alchemy.AWS.S3
