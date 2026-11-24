import Alchemy.Cloud.Hosted
import Alchemy.Cloud.Laws

/-!
# What a journal promises, and what hosting gives for it

A journal's law: reading answers its lines, and appending adds one at the end.
From that law alone, a host that sends its model a command leaves a journal
that replays to exactly the world it answered with. So what a host says
happened is what it wrote down, and the next request starts from it.
-/

namespace Alchemy.Cloud

variable {K : Type} [Cloud K] {role : Access K}

/--
A journal keeps its law against a cloud, given how to read its lines off that
cloud and which clouds it is sound on: reading answers the lines and changes
nothing, and appending adds one line at the end and keeps the cloud sound.
-/
structure Journal.Lawful (sim : Sim K) (journal : Journal role)
    (lines : sim.State → List Journal.Line) (sound : sim.State → Prop) : Prop where
  read : ∀ s, journal.read.eval sim s = (.ok (lines s), s)
  append : ∀ s line, sound s →
    ((journal.append line).eval sim s).1 = .ok () ∧
      lines ((journal.append line).eval sim s).2 = lines s ++ [line] ∧
      sound ((journal.append line).eval sim s).2

/-- What is written to a journal reads back as what it was. -/
structure Served.Faithful {m : Model} (served : Served m) : Prop where
  input : ∀ input, served.input.read (served.input.write input) = some input
  reply : ∀ c reply, (served.reply c).read ((served.reply c).write reply) = some reply

/-- Every served model is faithful: its codecs carry the proof. -/
theorem Served.faithful {m : Model} (served : Served m) : served.Faithful :=
  ⟨served.input.back, fun c => (served.reply c).back⟩

namespace Hosted

variable {m : Model} {served : Served m} {sim : Sim K} {lines : sim.State → List Journal.Line}
  {sound : sim.State → Prop}

/-- Reading the model back answers what its journal replays to, and changes nothing. -/
theorem world_eval (hosted : Hosted served role) (lawful : hosted.journal.Lawful sim lines sound)
    (s : sim.State) : hosted.world.eval sim s = (.ok (served.replay (lines s)), s) := by
  show Run.eval sim (Run.bind _ _) s = _
  rw [Run.eval_bind, lawful.read]
  rfl

/--
Answering the calls the model waits on keeps the journal and the world in step:
if the journal replayed to the world before, it replays to the world after.
-/
theorem answerCalls_recorded (hosted : Hosted served role)
    (lawful : hosted.journal.Lawful sim lines sound) (faithful : served.Faithful)
    (quiet : ∀ c s, sound s →
      lines ((hosted.call c).eval sim s).2 = lines s ∧ sound ((hosted.call c).eval sim s).2) :
    ∀ (calls : Nat) (w : Alchemy.World m.signature) (s : sim.State), sound s →
      served.replay (lines s) = w →
      ∃ w', ((hosted.answerCalls calls w).eval sim s).1 = .ok w' ∧
        served.replay (lines ((hosted.answerCalls calls w).eval sim s).2) = w' ∧
        sound ((hosted.answerCalls calls w).eval sim s).2 := by
  intro calls
  induction calls with
  | zero => intro w s ok same; exact ⟨w, rfl, same, ok⟩
  | succ calls ih =>
    intro w s sounds same
    unfold answerCalls
    split
    · exact ⟨w, rfl, same, sounds⟩
    · next c rest waiting =>
      show ∃ w', (Run.eval sim (Run.bind (hosted.call c) _) s).1 = _ ∧ _
      obtain ⟨reply, answered⟩ := Run.eval_never sim (hosted.call c) s
      obtain ⟨still, callSound⟩ := quiet c s sounds
      obtain ⟨appended, grown, appendSound⟩ := lawful.append ((hosted.call c).eval sim s).2
        (.answer ((served.reply c).write reply)) callSound
      have step : served.replay (lines ((hosted.journal.append
          (.answer ((served.reply c).write reply))).eval sim ((hosted.call c).eval sim s).2).2)
          = m.play Served.fuel w (.answer c reply) := by
        rw [grown, still, Served.replay, List.foldl_append, ← Served.replay, same]
        simp [Served.apply, waiting, faithful.reply]
      obtain ⟨w', ok, recorded, endSound⟩ := ih _ _ appendSound step
      refine ⟨w', ?_, ?_, ?_⟩
      · rw [Run.eval_bind, answered]
        show (Run.eval sim (Run.bind _ _) _).1 = _
        rw [Run.eval_bind, appended]
        exact ok
      · show served.replay (lines (Run.eval sim (Run.bind (hosted.call c) _) s).2) = _
        rw [Run.eval_bind, answered]
        show served.replay (lines (Run.eval sim (Run.bind _ _) _).2) = _
        rw [Run.eval_bind, appended]
        exact recorded
      · show sound (Run.eval sim (Run.bind (hosted.call c) _) s).2
        rw [Run.eval_bind, answered]
        show sound (Run.eval sim (Run.bind _ _) _).2
        rw [Run.eval_bind, appended]
        exact endSound

/--
A host answers what the model answers, and records what it applies. The answer
is the one the model, as the journal had it, gives the command. Afterwards the journal
replays to exactly the world the host answered with: whatever the cloud held
before, whatever the outside systems answered. It needs only the journal's law,
that what is written reads back, and that answering a call leaves the journal alone.
The cloud stays sound, so the same holds of the next request.
-/
theorem send_recorded (hosted : Hosted served role)
    (lawful : hosted.journal.Lawful sim lines sound) (faithful : served.Faithful)
    (quiet : ∀ c s, sound s →
      lines ((hosted.call c).eval sim s).2 = lines s ∧ sound ((hosted.call c).eval sim s).2)
    (input : served.Input) (s : sim.State) (sounds : sound s) :
    ∃ after, ((hosted.send input).eval sim s).1 =
        .ok ((served.replay (lines s)).toRecorded.outcome (served.replay (lines s)).now
          (served.command input), after) ∧
      served.replay (lines ((hosted.send input).eval sim s).2) = after ∧
      sound ((hosted.send input).eval sim s).2 := by
  obtain ⟨appended, grown, appendSound⟩ :=
    lawful.append s (.input (served.input.write input)) sounds
  have step : served.replay (lines ((hosted.journal.append
      (.input (served.input.write input))).eval sim s).2)
      = m.play Served.fuel (served.replay (lines s)) (.send (served.command input)) := by
    rw [grown, Served.replay, List.foldl_append, ← Served.replay]
    simp [Served.apply, faithful.input]
  obtain ⟨after, ok, recorded, endSound⟩ :=
    hosted.answerCalls_recorded lawful faithful quiet 100 _ _ appendSound step
  refine ⟨after, ?_, ?_, ?_⟩
  · show (Run.eval sim (Run.bind hosted.world _) s).1 = _
    rw [Run.eval_bind, hosted.world_eval lawful]
    show (Run.eval sim (Run.bind _ _) s).1 = _
    rw [Run.eval_bind, appended]
    show (Run.eval sim (Run.bind _ _) _).1 = _
    rw [Run.eval_bind, ok]
    rfl
  · show served.replay (lines (Run.eval sim (Run.bind hosted.world _) s).2) = _
    rw [Run.eval_bind, hosted.world_eval lawful]
    show served.replay (lines (Run.eval sim (Run.bind _ _) s).2) = _
    rw [Run.eval_bind, appended]
    show served.replay (lines (Run.eval sim (Run.bind _ _) _).2) = _
    rw [Run.eval_bind, ok]
    exact recorded
  · show sound (Run.eval sim (Run.bind hosted.world _) s).2
    rw [Run.eval_bind, hosted.world_eval lawful]
    show sound (Run.eval sim (Run.bind _ _) s).2
    rw [Run.eval_bind, appended]
    show sound (Run.eval sim (Run.bind _ _) _).2
    rw [Run.eval_bind, ok]
    exact endSound

/--
A host answers what the model answers. The caller of a command is told the
rejection the model, as the journal had it, gives; or the aggregate's reply
from the state the journal has afterwards. And the journal is still sound.
-/
theorem ask_recorded (hosted : Hosted served role)
    (lawful : hosted.journal.Lawful sim lines sound) (faithful : served.Faithful)
    (quiet : ∀ c s, sound s →
      lines ((hosted.call c).eval sim s).2 = lines s ∧ sound ((hosted.call c).eval sim s).2)
    (input : served.Input) (s : sim.State) (sounds : sound s) :
    ((hosted.ask input).eval sim s).1 =
        .ok (answered (served.command input)
          ((served.replay (lines s)).toRecorded.outcome (served.replay (lines s)).now
            (served.command input))
          (served.replay (lines ((hosted.ask input).eval sim s).2))) ∧
      sound ((hosted.ask input).eval sim s).2 := by
  obtain ⟨after, answer, recorded, stillSound⟩ :=
    hosted.send_recorded lawful faithful quiet input s sounds
  have evaluated : (hosted.ask input).eval sim s
      = (.ok (answered (served.command input)
          ((served.replay (lines s)).toRecorded.outcome (served.replay (lines s)).now
            (served.command input)) after),
        ((hosted.send input).eval sim s).2) := by
    show Run.eval sim (Run.bind _ _) s = _
    rw [Run.eval_bind, answer]
    rfl
  rw [evaluated]
  exact ⟨by rw [← recorded], stillSound⟩

end Hosted

end Alchemy.Cloud
