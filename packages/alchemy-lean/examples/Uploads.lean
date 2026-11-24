import Alchemy

/-!
# Uploads

People upload files from the internet. A file must not reach anyone until it
has been scanned, and an infected file must never be served.

Three functions share one bucket:

- `Upload` is public. It stores a file under `incoming/` and asks for a scan.
- `Scanner` is private. It reads the file, and writes it under `clean/` or `quarantine/`.
- `Download` is public. It serves files from `clean/`.

The safety of this design is entirely in who may touch which prefix. Those
rules are stated here as theorems about the stack, so a change that breaks one
does not build.
-/

open Alchemy Cloud AWS

namespace Uploads

def infected (body : String) : Bool := (body.splitOn "EICAR").length > 1

/-- Stores an upload where nothing public can read it, and asks for it to be scanned. -/
def Upload (files : Bucket) (scans : Queue) : Construct Kind Function :=
  Lambda.Function "Upload" { url := true } do
    return fun request => do
      match request.method, request.path with
      | .post, ["files", name] =>
        S3.putObject files ["incoming"] name request.body
        SQS.sendMessage scans name
        return { status := 202 }
      | _, _ => return { status := 404 }

/-- Scans one upload: a clean file is published, an infected one is set aside. -/
def scan {role : Access Kind} (files : Bucket)
    [Has role (S3.Get files ["incoming"])] [Has role (S3.Put files ["clean"])]
    [Has role (S3.Put files ["quarantine"])] (name : String) : Run role Never Unit := do
  match ← (S3.getObject files ["incoming"] name).result with
  | .ok body =>
    if infected body then S3.putObject files ["quarantine"] name body
    else S3.putObject files ["clean"] name body
  | .error _ => pure ()

def Scanner (files : Bucket) (scans : Queue) : Construct Kind Function :=
  Lambda.Function "Scanner" {} do
    SQS.consume scans fun name => scan files name
    return fun _ => return { status := 204 }

/-- Serves published files, and nothing else. -/
def Download (files : Bucket) : Construct Kind Function :=
  Lambda.Function "Download" { url := true } do
    return fun request => do
      match request.method, request.path with
      | .get, ["files", name] =>
        match ← (S3.getObject files ["clean"] name).result with
        | .ok body => return { status := 200, body }
        | .error _ => return { status := 404 }
      | _, _ => return { status := 404 }

structure Outputs where
  files : Bucket
  scans : Queue
  upload : Function
  scanner : Function
  download : Function
deriving Inhabited

def UploadStack : Stack Kind Outputs where
  name := "Uploads"
  body := do
    let files ← S3.Bucket "Files"
    let scans ← SQS.Queue "Scans"
    let upload ← Upload files scans
    let scanner ← Scanner files scans
    let download ← Download files
    return { files, scans, upload, scanner, download }

def prod : Graph Kind := UploadStack.graph "prod"
def out : Outputs := computed% (UploadStack.outputs "prod")

/-! ## What must be true of this stack -/

/-- Exactly two functions face the internet. A third would have to be added here on purpose. -/
theorem whatIsPublic : exposed prod = ["Upload", "Download"] := by decide

/--
Nothing public can read a file that has not been scanned. This is the rule the
design exists for, and it holds for every file name.
-/
theorem nothingPublicReadsAnUnscannedFile :
    nothingExposed prod (S3.reading out.files ["incoming"]) := by
  simp only [nothingExposed, whatIsPublic]
  stack_rule in prod using [out, BucketOp.covers]

/-- Nothing public can read what was quarantined, either. In fact nothing at all can. -/
theorem nobodyReadsTheQuarantine : prod.nobody (S3.reading out.files ["quarantine"]) := by
  stack_rule in prod using [out, BucketOp.covers]

/--
Only the Scanner publishes. So every file `Download` can serve was put there by
the Scanner: there is no way around the scan.
-/
theorem onlyTheScannerPublishes :
    prod.only [out.scanner] (S3.writing out.files ["clean"]) := by
  stack_rule in prod using [out, BucketOp.covers]

/-- If `Upload` is taken over, it can read nothing: not uploads, not published files. -/
theorem uploadReadsNothing : prod.never out.upload (S3.reading out.files) := by
  stack_rule in prod using [out, BucketOp.covers]

/-- If `Download` is taken over, it can change nothing: no file, and no scan request. -/
theorem downloadChangesNothing :
    prod.never out.download (S3.writing out.files) ∧
      prod.only [out.upload] (SQS.sending out.scans) := by
  constructor <;> stack_rule in prod using [out, BucketOp.covers]

/-- No function can invoke another, so taking one over does not lead to the others. -/
theorem noFunctionInvokesAnother (function : Function) :
    prod.nobody (Lambda.invoking function) := by
  stack_rule in prod using [out]

/-! ## What a function can do if it is taken over

The rules above are about roles. These are about code: any code at all,
running with a public function's role. They hold because a call the role does
not permit cannot be written, so they cover an attacker's code as well as ours.
-/

/-- Whatever runs as `Upload`, it cannot publish or alter a published file. -/
theorem uploadCannotPublish {ε α : Type} (code : Run (prod.roleOf "Upload") ε α) (cloud : Memory)
    (name : String) :
    (code.exec InMemory cloud).state.object out.files ["clean", name]
      = cloud.object out.files ["clean", name] := by
  refine Run.leaves code cloud _ _ ?_
  have role : prod.roleOf "Upload" = computed% (prod.roleOf "Upload") := rfl
  have differ : ¬BucketOp.put ["incoming"] = BucketOp.put ["clean", name] := by simp
  simp [role, out, Access.permits, permitsOn, Kinds.covers, BucketOp.covers, List.isPrefixOf, differ]

/-- Whatever runs as `Download`, it cannot either. -/
theorem downloadCannotPublish {ε α : Type} (code : Run (prod.roleOf "Download") ε α)
    (cloud : Memory) (name : String) :
    (code.exec InMemory cloud).state.object out.files ["clean", name]
      = cloud.object out.files ["clean", name] := by
  refine Run.leaves code cloud _ _ ?_
  have role : prod.roleOf "Download" = computed% (prod.roleOf "Download") := rfl
  simp [role, out, Kinds.covers, BucketOp.covers]

/-! ## The whole design: nothing infected is ever published -/

/-- Every published file is clean. -/
def Safe (cloud : Memory) : Prop :=
  ∀ name body, cloud.object out.files ["clean", name] = some body → infected body = false

section
variable {role : Access Kind}
  [Has role (S3.Get out.files ["incoming"])] [Has role (S3.Put out.files ["clean"])]
  [Has role (S3.Put out.files ["quarantine"])]

/-- What a scan leaves: nothing, the file in quarantine, or the file published. -/
theorem scan_eval (name : String) (cloud : Memory) :
    ((scan (role := role) out.files name).eval InMemory cloud).2 =
      match cloud.object out.files ["incoming", name] with
      | none => cloud
      | some body =>
        if infected body then cloud.put out.files ["quarantine", name] body
        else cloud.put out.files ["clean", name] body := by
  have read := S3.getObject_eval (role := role) out.files ["incoming"] name cloud
  show (Run.eval InMemory (Run.bind _ _) cloud).2 = _
  rw [Run.eval_bind, Run.eval_result, read]
  have key : (["incoming"] ++ [name] : Path) = ["incoming", name] := rfl
  rw [key]
  cases found : cloud.object out.files ["incoming", name] with
  | none => rfl
  | some body =>
    by_cases bad : infected body = true
    · simp only [bad, ite_true]
      exact congrArg Prod.snd (S3.putObject_eval out.files ["quarantine"] name body cloud)
    · simp only [bad]
      exact congrArg Prod.snd (S3.putObject_eval out.files ["clean"] name body cloud)

/-- A scan keeps every published file clean. -/
theorem scan_safe (name : String) (cloud : Memory) (safe : Safe cloud) :
    Safe ((scan (role := role) out.files name).eval InMemory cloud).2 := by
  rw [scan_eval]
  cases found : cloud.object out.files ["incoming", name] with
  | none => exact safe
  | some body =>
    intro published content held
    by_cases bad : infected body = true
    · simp only [bad, ite_true] at held
      rw [Memory.object_put_other _ _ _ _ _ _ (by simp)] at held
      exact safe published content held
    · have clean : infected body = false := by simpa using bad
      simp only [clean, Bool.false_eq_true, ite_false] at held
      by_cases same : published = name
      · subst same
        rw [Memory.object_put_self] at held
        cases held
        exact clean
      · rw [Memory.object_put_other _ _ _ _ _ _ (by simp [same])] at held
        exact safe published content held

end

/--
The states of the cloud this stack can reach. The Scanner runs its own code on
any upload. The two public functions run any code whatever under their roles:
ours, or an attacker's.
-/
inductive Reaches : Memory → Prop where
  | start : Reaches {}
  | upload {cloud ε α} (code : Run (prod.roleOf "Upload") ε α) :
      Reaches cloud → Reaches (code.exec InMemory cloud).state
  | download {cloud ε α} (code : Run (prod.roleOf "Download") ε α) :
      Reaches cloud → Reaches (code.exec InMemory cloud).state
  | scan {cloud} {role : Access Kind}
      [Has role (S3.Get out.files ["incoming"])] [Has role (S3.Put out.files ["clean"])]
      [Has role (S3.Put out.files ["quarantine"])] (name : String) :
      Reaches cloud → Reaches ((scan (role := role) out.files name).eval InMemory cloud).2

/--
No infected file is ever published. In every state this stack can reach,
whatever is uploaded, in whatever order things run, and even if both public
functions are taken over, every file `Download` can serve is clean.
-/
theorem noInfectedFileIsEverPublished (cloud : Memory) (reach : Reaches cloud) : Safe cloud := by
  induction reach with
  | start => intro name body held; simp [Memory.object] at held
  | upload code _ safe =>
    intro name body held
    rw [uploadCannotPublish] at held
    exact safe name body held
  | download code _ safe =>
    intro name body held
    rw [downloadCannotPublish] at held
    exact safe name body held
  | scan name _ safe => exact scan_safe name _ safe

/--
So nothing `Download` serves is infected. In any state the stack can reach, if
a file can be read from where `Download` reads, it is clean.
-/
theorem nothingServedIsInfected {role : Access Kind} [Has role (S3.Get out.files ["clean"])]
    (cloud : Memory) (reach : Reaches cloud) (name body : String)
    (served : ((S3.getObject (role := role) out.files ["clean"] name).eval InMemory cloud).1
      = .ok body) : infected body = false := by
  rw [S3.getObject_eval] at served
  have key : (["clean"] ++ [name] : Path) = ["clean", name] := rfl
  rw [key] at served
  cases held : cloud.object out.files ["clean", name] with
  | none => simp [held] at served
  | some content =>
    simp only [held, Except.ok.injEq] at served
    subst served
    exact noInfectedFileIsEverPublished cloud reach name content held

/-! ## Tests of the stack -/

def aCleanFile : List (Graph.Step Kind InMemory) := [
  .request out.upload { method := .post, path := ["files", "notes.txt"], body := "hello" }
    (responds { status := 202 }),
  get out.download "/files/notes.txt" ⇒ (200, "hello") ]

def anInfectedFile : List (Graph.Step Kind InMemory) := [
  .request out.upload { method := .post, path := ["files", "virus.exe"], body := "xxEICARxx" }
    (responds { status := 202 }),
  get out.download "/files/virus.exe" ⇒ (404, ""),
  .holds "it was set aside" (·.object out.files ["quarantine", "virus.exe"] == some "xxEICARxx") ]

example : prod.passes aCleanFile = true := by native_decide
example : prod.passes anInfectedFile = true := by native_decide

def fresh : Cloud.World Kind Control.Service := ⟨.empty, {}⟩

end Uploads
