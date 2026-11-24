import Alchemy.Cloud.AWS
import Alchemy.Cloud.Laws

/-!
# What the AWS bindings promise

Each binding has a law: what a call answers and what it does to the cloud. The
laws are stated against the model of S3 and SQS, and each binding's own
implementation is proved to keep its law. Code built on a binding is then
proved from the law, without looking inside the binding.
-/

namespace Alchemy.AWS
open Alchemy.Cloud

variable {access : Access Kind}

/-! ## The model: what a write does, as seen by a read -/

namespace Memory

theorem object_put_self (m : Memory) (bucket : AWS.Bucket) (key : Path) (body : String) :
    (m.put bucket key body).object bucket key = some body := by
  simp only [object, put, List.find?_append]
  rw [List.find?_eq_none.mpr]
  · simp
  · intro x mem
    simp only [List.mem_filter] at mem
    have differs := mem.2
    simp only [Bool.not_eq_true', Bool.and_eq_false_iff, beq_eq_false_iff_ne] at differs
    intro same
    simp only [Bool.and_eq_true, beq_iff_eq] at same
    rcases differs with n | n
    · exact n same.1
    · exact n same.2

theorem object_put_other (m : Memory) (bucket other : AWS.Bucket) (key otherKey : Path) (body : String)
    (ne : ¬(other.id = bucket.id ∧ otherKey = key)) :
    (m.put bucket key body).object other otherKey = m.object other otherKey := by
  simp only [object, put, List.find?_append]
  have last : ([(bucket.id, key, body)].find? fun x => x.1 == other.id && x.2.1 == otherKey) = none := by
    simp only [List.find?_cons, List.find?_nil]
    split
    · next h =>
      simp only [Bool.and_eq_true, beq_iff_eq] at h
      exact absurd ⟨h.1.symm, h.2.symm⟩ ne
    · rfl
  rw [last, Option.or_none, List.find?_filter]
  congr 2
  funext x
  obtain ⟨id, k, b⟩ := x
  by_cases h : id = other.id ∧ k = otherKey
  · obtain ⟨rfl, rfl⟩ := h
    have keep : (!(other.id == bucket.id && k == key)) = true := by
      simp only [Bool.not_eq_true', Bool.and_eq_false_iff, beq_eq_false_iff_ne]
      by_cases same : other.id = bucket.id
      · exact .inr fun h => ne ⟨same, h⟩
      · exact .inl same
    simp [keep]
  · have : (id == other.id && k == otherKey) = false := by simpa using h
    simp [this]

/-- A write leaves every queue as it was. -/
@[simp] theorem queued_put (m : Memory) (bucket : AWS.Bucket) (key : Path) (body : String)
    (queue : AWS.Queue) : (m.put bucket key body).queued queue = m.queued queue := rfl

/-- A message sent goes to the back of its queue. -/
theorem queued_send_self (m : Memory) (queue : AWS.Queue) (body : String) :
    (m.send queue body).queued queue = m.queued queue ++ [body] := by
  simp [queued, send]

theorem queued_send_other (m : Memory) (queue other : AWS.Queue) (body : String)
    (ne : other.id ≠ queue.id) : (m.send queue body).queued other = m.queued other := by
  simp [queued, send, Ne.symm ne]

/-- Sending leaves every object as it was. -/
@[simp] theorem object_send (m : Memory) (queue : AWS.Queue) (body : String) (bucket : AWS.Bucket)
    (key : Path) : (m.send queue body).object bucket key = m.object bucket key := rfl

@[simp] theorem keys_send (m : Memory) (queue : AWS.Queue) (body : String) (bucket : AWS.Bucket) :
    (m.send queue body).keys bucket = m.keys bucket := rfl

/-- Receiving leaves every object as it was. -/
@[simp] theorem object_receive (m : Memory) (queue : AWS.Queue) (bucket : AWS.Bucket) (key : Path) :
    (m.receive queue).object bucket key = m.object bucket key := by
  unfold receive
  split <;> rfl

end Memory

/-! ## S3 -/

namespace S3

/-- Reading answers what the model holds at the key, and changes nothing. -/
structure GetObject.Lawful {bucket : AWS.Bucket} {under : Path}
    (client : GetObject.Client bucket under access) : Prop where
  get : ∀ (m : Memory) (name : String),
    (client.call name).eval InMemory m =
      (match m.object bucket (under ++ [name]) with
        | some body => .ok body
        | none => .error (.noSuchKey { bucket := bucket.id, key := under ++ [name] }), m)

/-- Writing answers, and leaves the model with the object at the key. -/
structure PutObject.Lawful {bucket : AWS.Bucket} {under : Path}
    (client : PutObject.Client bucket under access) : Prop where
  put : ∀ (m : Memory) (name body : String),
    (client.call name body).eval InMemory m = (.ok (), m.put bucket (under ++ [name]) body)

/-- Listing answers the bucket's keys, and changes nothing. -/
structure ListObjects.Lawful {bucket : AWS.Bucket} (client : ListObjects.Client bucket access) :
    Prop where
  list : ∀ (m : Memory), client.call.eval InMemory m = (.ok (m.keys bucket), m)

theorem GetObjectLive.lawful (bucket : AWS.Bucket) (under : Path)
    (le : (GetObjectLive bucket under).needs ≤ access) :
    GetObject.Lawful ((GetObjectLive bucket under).build le ⟨⟩) where
  get m name := by
    cases found : m.object bucket (under ++ [name]) <;>
      simp [GetObjectLive, Run.eval, Run.performUnder, bind, Run.bind, Run.exec, InMemory, simulate,
        found, throw, pure]

theorem PutObjectLive.lawful (bucket : AWS.Bucket) (under : Path)
    (le : (PutObjectLive bucket under).needs ≤ access) :
    PutObject.Lawful ((PutObjectLive bucket under).build le ⟨⟩) where
  put _ _ _ := rfl

theorem ListObjectsLive.lawful (bucket : AWS.Bucket)
    (le : (ListObjectsLive bucket).needs ≤ access) :
    ListObjects.Lawful ((ListObjectsLive bucket).build le ⟨⟩) where
  list _ := rfl

end S3

/-! ## SQS -/

namespace SQS

/-- Sending answers, and leaves the model with the message sent. -/
structure SendMessage.Lawful {queue : AWS.Queue} (client : SendMessage.Client queue access) :
    Prop where
  send : ∀ (m : Memory) (body : String),
    (client.call body).eval InMemory m = (.ok (), m.send queue body)

/-- Receiving answers the message at the front, if there is one, and takes it off. -/
structure ReceiveMessage.Lawful {queue : AWS.Queue} (client : ReceiveMessage.Client queue access) :
    Prop where
  receive : ∀ (m : Memory),
    client.call.eval InMemory m = (.ok (m.queued queue).head?, m.receive queue)

theorem SendMessageLive.lawful (queue : AWS.Queue)
    (le : (SendMessageLive queue).needs ≤ access) :
    SendMessage.Lawful ((SendMessageLive queue).build le ⟨⟩) where
  send _ _ := rfl

theorem ReceiveMessageLive.lawful (queue : AWS.Queue)
    (le : (ReceiveMessageLive queue).needs ≤ access) :
    ReceiveMessage.Lawful ((ReceiveMessageLive queue).build le ⟨⟩) where
  receive _ := rfl

end SQS

end Alchemy.AWS

namespace Alchemy.AWS
open Alchemy.Cloud

/--
Code cannot change an object its role does not let it write. Whatever the code
is, whatever it is asked and whatever the cloud holds: if the role does not
permit writing a key, that key holds afterwards what it held before.
-/
theorem Run.leaves {access : Access Kind} {ε α : Type} (run : Run access ε α) (m : Memory)
    (bucket : AWS.Bucket) (key : Path)
    (cannot : access.permits ⟨.bucket, bucket, BucketOp.put key⟩ = false) :
    (run.exec InMemory m).state.object bucket key = m.object bucket key := by
  induction run generalizing m with
  | pure a => rfl
  | fail e => rfl
  | call ref c ok next ih =>
    rename_i k
    show ((next (simulate ref c m).1).exec InMemory (simulate ref c m).2.1).state.object bucket key = _
    rw [ih]
    cases k with
    | function => exact nomatch c
    | queue => cases c <;> simp [simulate]
    | bucket =>
      cases c with
      | getObject key' => rfl
      | listObjects => rfl
      | putObject key' body =>
        show (m.put ref key' body).object bucket key = _
        by_cases same : ref.id = bucket.id ∧ key' = key
        · obtain ⟨sameId, rfl⟩ := same
          have : ref = bucket := by cases ref; cases bucket; simp_all
          subst this
          have permitted : access.permits ⟨.bucket, ref, BucketOp.put key'⟩ = true := ok
          rw [permitted] at cannot
          cases cannot
        · exact Memory.object_put_other m ref bucket key' key body
            (fun h => same ⟨h.1.symm, h.2.symm⟩)

end Alchemy.AWS
