import Alchemy

/-!
# Jobs

One program: the resources, the code that runs on them, and what is proved
about both. An Api stores jobs in a bucket; every stored job is forwarded to a
queue; a Worker takes jobs off the queue; an Auditor may list jobs and nothing
else.
-/

open Alchemy Cloud AWS

namespace Jobs

/-! ## A service, and a layer that gives it -/

/-- There is no job of this id. -/
structure JobNotFound where
  id : String
deriving DecidableEq, Repr

/-- Where jobs are kept. Code that uses it does not know where that is. -/
structure JobStorage (access : Access Kind) where
  put : String → String → Run access Never Unit
  get : String → Run access JobNotFound String

variable {R : Service Kind} {ε : Type}

def putJob [Uses R JobStorage] (id content : String) : Effect R ε Unit :=
  use JobStorage (·.put id content)

def getJob [Uses R JobStorage] [Raises ε JobNotFound] (id : String) : Effect R ε String :=
  use JobStorage (·.get id)

/--
Jobs kept as objects under `jobs/`. Built from the two S3 services it calls,
so it needs what they need: read and write under that prefix. S3's error
becomes the service's own.
-/
def JobStorageS3 (bucket : Bucket) : Layer Nothing JobStorage :=
  .from (S3.GetObjectLive bucket ["jobs"] ++ S3.PutObjectLive bucket ["jobs"]) do
    let objects ← S3.GetObject bucket ["jobs"]
    let store ← S3.PutObject bucket ["jobs"]
    return {
      put := fun id content => store.call id content
      get := fun id =>
        (objects.call id).mapError fun
          | S3.GetObjectError.noSuchKey _ => JobNotFound.mk id }

/-! ## The functions -/

/--
Answers a request for a job. It names the service it needs, and no resource.
It handles the one error it can meet, so its type says it cannot fail.
-/
def jobs [Uses R JobStorage] (request : Request) : Effect R Never Response := do
  match request.method, request.path with
  | .get, [id] =>
    match ← (getJob id).result with
    | .ok content => return { status := 200, body := content }
    | .error (missing : JobNotFound) =>
      return { status := 404, body := s!"Job {missing.id} not found" }
  | .post, [id] =>
    if request.body.isEmpty then return { status := 400, body := "Job content is required" }
    putJob id request.body
    return { status := 201, body := id }
  | _, _ => return { status := 404, body := "Not found" }

/-- How forwarding a stored job can fail. -/
inductive ForwardError where
  | notAJob (key : Path)
  | missing (job : JobNotFound)
deriving DecidableEq, Repr

instance : Raises ForwardError JobNotFound := ⟨.missing⟩

/-- Sends a stored job to the queue. -/
def forward (queue : Queue) [Uses R JobStorage] [Uses R (SQS.SendMessage.Client queue)] (key : Path) :
    Effect R ForwardError Unit := do
  let some id := key.getLast? | throw (.notAJob key)
  let content ← getJob id
  SQS.sendMessageE queue content

def Api (bucket : Bucket) (queue : Queue) : Construct Kind Function := do
  let stage ← stage
  Lambda.FunctionWith "Api" { url := true, memory := if stage = "prod" then 1024 else 512 } do
    serve (JobStorageS3 bucket ++ SQS.SendMessageLive queue) jobs
      [S3.onObjectCreated bucket (forward queue)]

def Worker (queue : Queue) : Construct Kind Function :=
  Lambda.FunctionWith "Worker" {} do
    serve (SQS.ReceiveMessageLive queue) fun _ => do
      match ← SQS.receiveMessage queue with
      | some job => return { status := 200, body := job }
      | none => return { status := 204 }

def Auditor (bucket : Bucket) : Construct Kind Function :=
  Lambda.FunctionWith "Auditor" {} do
    serve (S3.ListObjectsLive bucket) fun _ => do
      let keys ← S3.listObjects bucket
      return { status := 200, body := toString keys.length }

/-! ## The stack -/

structure Outputs where
  api : Function
  worker : Function
  auditor : Function

def JobStack : Stack Kind Outputs where
  name := "Jobs"
  body := do
    let stage ← stage
    let bucket ← S3.Bucket "JobsBucket"
    let queue ← SQS.Queue "JobsQueue" { visibilityTimeout := if stage = "prod" then 120 else 30 }
    let api ← Api bucket queue
    let worker ← Worker queue
    let auditor ← Auditor bucket
    return { api, worker, auditor }

/-! ## The graph it builds -/

def prod : Graph Kind := JobStack.graph "prod"

def bucket : Bucket := ⟨"JobsBucket"⟩
def queue : Queue := ⟨"JobsQueue"⟩
def api : Function := ⟨"Api"⟩
def worker : Function := ⟨"Worker"⟩
def auditor : Function := ⟨"Auditor"⟩

/-- The stack builds, and every resource it names exists. -/
example : JobStack.problem "prod" = none ∧ prod.deployable = true := by decide

/-- The resources, in an order they can be created in. -/
example : prod.order = ["JobsBucket", "JobsQueue", "Api", "Worker", "Auditor"] := by decide

/-- The edges: who needs what. -/
example : prod.edges = [
    ("Api", "JobsBucket"), ("Api", "JobsQueue"),
    ("Worker", "JobsQueue"),
    ("Auditor", "JobsBucket")] := by decide

/-! ## What is proved about access -/

/-- Only the Api can write an object, whatever the key. -/
theorem onlyTheApiWrites : prod.only [api] (S3.writing bucket) := by
  stack_rule in prod using [bucket, api]

/-- And it can write nowhere but under `jobs/`. -/
theorem theApiWritesOnlyJobs (key : Path) (elsewhere : ¬["jobs"] <+: key) :
    prod.can "Api" ⟨.bucket, bucket, BucketOp.put key⟩ = false := by
  have roles : prod.roles = computed% prod.roles := rfl
  simp [Graph.can, roles, Access.permits, permitsOn, Kinds.covers, BucketOp.covers, bucket]
  constructor
  · intro same
    cases same
    exact elsewhere (List.prefix_refl _)
  · cases prefixed : ["jobs"].isPrefixOf key with
    | false => rfl
    | true => exact absurd (List.isPrefixOf_iff_prefix.mp prefixed) elsewhere

/-- Nothing but the Worker takes jobs off the queue. -/
theorem onlyTheWorkerReceives : prod.only [worker] (SQS.receiving queue) := by
  stack_rule in prod using [queue, worker]

/-- The Auditor can count jobs, and can read none of them. -/
theorem theAuditorReadsNothing : prod.never auditor (S3.reading bucket) := by
  stack_rule in prod using [bucket, auditor]

/-- No function can invoke another. -/
theorem noFunctionInvokesAnother (target : Function) : prod.nobody (Lambda.invoking target) := by
  stack_rule in prod

/-! ## What is proved about the code -/

/--
Whatever the Api is asked, in whatever state the cloud is in, every call it
makes is one its role allows. It holds for any host, because a call that the
role does not permit does not type check.
-/
theorem theApiStaysInItsRole (request : Request) (memory : Memory) :
    match prod.handler api request with
    | some ⟨access, run⟩ => ∀ t ∈ (run.exec InMemory memory).attempts, access.permits t = true
    | none => True := by
  split
  · exact Run.exec_permitted _ _ _
  · trivial

/-- The same code with jobs kept in memory of its own needs no access at all. -/
def JobStorageNowhere : Layer Nothing JobStorage :=
  .make fun _ => { put := fun _ _ => pure (), get := fun id => .fail ⟨id⟩ }

example : JobStorageNowhere.needs = ∅ := rfl

/-- And so makes no call, whatever it is asked. -/
theorem jobsWithoutACloudTouchNothing (request : Request) (memory : Memory) :
    (((jobs request).provide JobStorageNowhere).exec InMemory memory).attempts = [] := by
  have permitted := Effect.provide_permitted InMemory (jobs request) JobStorageNowhere memory
  cases attempts : (((jobs request).provide JobStorageNowhere).exec InMemory memory).attempts with
  | nil => rfl
  | cons t _ =>
    have := permitted t (by rw [attempts]; exact List.mem_cons_self)
    simp [JobStorageNowhere, Layer.make] at this

/-! ## Tests of the stack, run when this file compiles -/

abbrev Test := List (Graph.Step Kind InMemory)

def storingAJob : Test := [
  .request api { method := .post, path := ["j-1"], body := "resize the logo" }
    (responds { status := 201, body := "j-1" }),
  .holds "the job is stored" (·.object bucket ["jobs", "j-1"] == some "resize the logo"),
  .holds "and forwarded to the queue" (·.queued queue == ["resize the logo"]),
  .request api { path := ["j-1"] } (responds { status := 200, body := "resize the logo" }),
  .request api { path := ["j-2"] } (responds { status := 404, body := "Job j-2 not found" }) ]

def workingAJob : Test := storingAJob ++ [
  .request worker {} (responds { status := 200, body := "resize the logo" }),
  .holds "the queue is empty" (·.queued queue == []),
  .request worker {} (responds { status := 204 }) ]

def auditing : Test := storingAJob ++ [
  .request auditor {} (responds { status := 200, body := "1" }) ]

example : prod.passes storingAJob = true := by native_decide
example : prod.passes workingAJob = true := by native_decide
example : prod.passes auditing = true := by native_decide

/--
Least privilege: no function holds a grant it does not need. For each one there
is a run in which that function makes a call the grant is what permits. Give a
function a grant it never uses and this fails.
-/
theorem leastPrivilege : prod.LeastPrivilege InMemory :=
  .of_tests [workingAJob, auditing] (by native_decide)

/-! ## Deploying it -/

open Control in
/-- An account with nothing in it, and an engine that has deployed nothing. -/
def fresh : World Kind Service := ⟨.empty, {}⟩

def deploy (g : Graph Kind) (w : World Kind Control.Service) : World Kind Control.Service × Bool :=
  apply Control.providers Control.Service g w

def planned (g : Graph Kind) (w : World Kind Control.Service) : List (String × Action) :=
  plan Control.providers g w.state

/-- The first deploy creates everything, each resource after what it needs. -/
example : planned prod fresh = [
    ("JobsBucket", .create), ("JobsQueue", .create),
    ("Api", .create), ("Worker", .create), ("Auditor", .create)] := by native_decide

/-- It succeeds, and deploying again has nothing to do. -/
example : (deploy prod fresh).2 = true ∧
    planned prod (deploy prod fresh).1 = [
      ("JobsBucket", .noop), ("JobsQueue", .noop),
      ("Api", .noop), ("Worker", .noop), ("Auditor", .noop)] := by native_decide

/-- Moving from dev to prod changes the queue's timeout and the Api's memory in place. -/
example : planned prod (deploy (JobStack.graph "dev") fresh).1 = [
    ("JobsBucket", .noop), ("JobsQueue", .update),
    ("Api", .update), ("Worker", .noop), ("Auditor", .noop)] := by native_decide

/-- The same stack with a first-in-first-out queue and no Auditor. -/
def Reworked : Stack Kind Unit where
  name := "Jobs"
  body := do
    let bucket ← S3.Bucket "JobsBucket"
    let queue ← SQS.Queue "JobsQueue" { fifo := true, visibilityTimeout := 120 }
    let _ ← Api bucket queue
    let _ ← Worker queue

/-- A queue cannot become first-in-first-out, so it is replaced; the Auditor is deleted. -/
example : planned (Reworked.graph "prod") (deploy prod fresh).1 = [
    ("JobsBucket", .noop), ("JobsQueue", .replace), ("Api", .noop), ("Worker", .noop),
    ("Auditor", .delete)] := by native_decide

/-- After that deploy the old queue and the Auditor are gone from the account, and the new queue is there. -/
example :
    let after := (deploy (Reworked.graph "prod") (deploy prod fresh).1).1.cloud
    (after.queues ⟨"JobsQueue", 0⟩).isNone ∧ (after.queues ⟨"JobsQueue", 1⟩).isSome ∧
      (after.functions ⟨"Auditor", 0⟩).isNone := by native_decide

/-- An account where somebody else already has the bucket's name. -/
def nameTaken : World Kind Control.Service :=
  ⟨.empty, { taken := fun name => name == ⟨"JobsBucket", 0⟩ }⟩

/--
The deploy fails at the bucket, but carries on with what does not need it
directly: the queue exists. The state says the bucket is still being created, so
the next deploy picks it up.
-/
example :
    (deploy prod nameTaken).2 = false ∧
      ((deploy prod nameTaken).1.cloud.queues ⟨"JobsQueue", 0⟩).isSome ∧
      planned prod (deploy prod nameTaken).1 = [
        ("JobsBucket", .create), ("JobsQueue", .noop),
        ("Api", .noop), ("Worker", .noop), ("Auditor", .noop)] := by native_decide

/-! ## What is proved about deploying it -/

theorem fresh_tracked : Tracked Control.lawful fresh := by
  intro y present
  obtain ⟨_ | _ | _, id, generation⟩ := y <;>
    simp [Control.lawful, Control.present, fresh] at present

/--
Deploying any graph to a fresh account leaks nothing, whatever fails and
wherever it stops: every resource in the account is one the state knows about.
-/
theorem deployLeaksNothing (g : Graph Kind) : Tracked Control.lawful (deploy g fresh).1 :=
  apply_tracked Control.lawful g fresh fresh_tracked

/-- And so does every deploy after it, of any other graph. -/
theorem redeployLeaksNothing (first second : Graph Kind) :
    Tracked Control.lawful (deploy second (deploy first fresh).1).1 :=
  apply_tracked Control.lawful second _ (deployLeaksNothing first)

/--
When a deploy of this stack succeeds, from any earlier deploy of anything, the
account holds only this stack's resources.
-/
theorem deployLeavesOnlyTheStack (earlier : Graph Kind) (y : Physical Kind)
    (ok : (deploy prod (deploy earlier fresh).1).2 = true)
    (exists_ : Control.present y (deploy prod (deploy earlier fresh).1).1.cloud = true) :
    y.id ∈ ["JobsBucket", "JobsQueue", "Api", "Worker", "Auditor"] := by
  obtain ⟨node, found, _⟩ := apply_exact Control.lawful prod _ (deployLeaksNothing earlier)
    (by decide) ok y exists_
  have listed : y.id ∈ prod.ids := by
    have mem := List.mem_of_find?_eq_some found
    have id := find_id found
    exact id ▸ List.mem_map_of_mem (f := Node.id) mem
  have ids : prod.ids = ["JobsBucket", "JobsQueue", "Api", "Worker", "Auditor"] := by decide
  rw [← ids]; exact listed

end Jobs
