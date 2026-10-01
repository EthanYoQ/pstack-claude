/-!
A Lean model of one piece of sequential logic: the two counters of a bounded
in-order queue (`next` items claimed, `consumed` items consumed, at most
`w` in flight). The shape to copy:

1. the state and the steps, written from the code, with the same arithmetic;
2. the invariant as a `Prop` with a `Decidable` instance;
3. a bounded exhaustive check (`#eval badPairs`) that prints every violating
   state and step up to a size, the cheap counter-example finder;
4. the proof for every size, by cases on the step.

A `sorry` left in step 4 is a named gap; `lean-check.sh` fails on it.
-/

structure State where
  next : Nat
  consumed : Nat
deriving Repr, DecidableEq

def Invariant (w : Nat) (s : State) : Prop := s.consumed ≤ s.next ∧ s.next ≤ s.consumed + w

instance (w : Nat) (s : State) : Decidable (Invariant w s) := by unfold Invariant; infer_instance

/-- The steps, as executable functions of the state: `none` when the guard fails. -/
def claim (w : Nat) (s : State) : Option State :=
  if s.next < s.consumed + w then some { s with next := s.next + 1 } else none

def consume (s : State) : Option State :=
  if s.consumed < s.next then some { s with consumed := s.consumed + 1 } else none

/-- Every state with both counters at most `n` from which one step leaves the
invariant: a counter-example is a `(before, after)` pair. -/
def badPairs (w n : Nat) : List (State × State) :=
  (List.range (n + 1)).flatMap fun a =>
    (List.range (n + 1)).flatMap fun b =>
      let s : State := ⟨a, b⟩
      if Invariant w s then
        [claim w s, consume s].filterMap fun t =>
          match t with
          | some t' => if Invariant w t' then none else some (s, t')
          | none => none
      else []

#eval badPairs 2 6   -- []

theorem invariant_init (w : Nat) : Invariant w ⟨0, 0⟩ := by
  simp [Invariant]

theorem claim_keeps_invariant (w : Nat) (s t : State) (hs : Invariant w s) (h : claim w s = some t) :
    Invariant w t := by
  unfold claim at h
  split at h
  · cases h
    simp only [Invariant] at *
    omega
  · cases h

theorem consume_keeps_invariant (w : Nat) (s t : State) (hs : Invariant w s) (h : consume s = some t) :
    Invariant w t := by
  unfold consume at h
  split at h
  · cases h
    simp only [Invariant] at *
    omega
  · cases h
