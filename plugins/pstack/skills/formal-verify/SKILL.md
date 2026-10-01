---
name: formal-verify
description: "Formally model and verify the tricky parts of a codebase: TLA+ and TLC for thread protocols (hand-overs, pipelines, shutdown, error lifecycles), Lean 4 for sequential invariants (index and window arithmetic, encoders, state machines). Pick the targets, model each one, prove the properties or get a counter-example, map the counter-example back to a line-level reproduction and a fix, and keep the model in CI. Use for /formal-verify, 'formally verify', 'model-check this', 'TLA+ this', 'prove this in Lean', 'find the race conditions', or when a bug cannot be reproduced by running the code."
---

# Formal verify

**Model the part, not the program. A model checker or a prover exhausts what a test samples; a counter-example is a line-level bug report, and a pass is evidence only when every property kills a mutant or every theorem is closed without `sorry`.**

Two tools, chosen by what can go wrong:

| What can go wrong | Tool | Why |
| --- | --- | --- |
| An interleaving: a lost wakeup, a double free across threads, an item delivered twice or out of order, a close that never returns, an error reported by the wrong thread | TLA+ with TLC | TLC enumerates every interleaving of a small instance and returns the shortest failing one |
| A value: an index or window boundary off by one, an invariant a transform breaks, an encoder and decoder that do not round-trip, a state machine that reaches a state the code assumes impossible | Lean 4 | Lean checks a bounded instance by evaluation in seconds and then proves the property for every size |

A thread protocol that also carries arithmetic (slot = item mod window) gets both: TLA+ for the interleavings with the arithmetic as a constant, Lean for the arithmetic alone.

Tooling. TLA+: Java and `tla2tools.jar`; [`scripts/tlc-matrix.sh`](scripts/tlc-matrix.sh) downloads the pinned jar, runs a matrix of constants and prints one PASS or FAIL line per run with its state count, and [`scripts/tlc-trace.py`](scripts/tlc-trace.py) reduces a counter-example to what each step changed. On macOS `/usr/bin/java` is a stub that prints "Unable to locate a Java Runtime" and some scripts still exit 0 after it, so set `JAVA=/opt/homebrew/opt/openjdk/bin/java` (or your JDK) and check that at least one PASS line printed. Lean: `elan` and `lake`; [`scripts/lean-check.sh`](scripts/lean-check.sh) builds a lake project and fails on any error or any theorem that still uses `sorry`, naming each; [`examples/lean-template/`](examples/lean-template/Model.lean) is a project that builds, with the shape every model copies.

## 1. Pick the targets

Grep for the primitives (`pthread_cond`, `pthread_mutex`, `atomic_`, `std::condition_variable`, `sync.Cond`, `chan`, `select`, `asyncio.Condition`, `Semaphore`, `atexit`, `setjmp`) and for state names that smell like a protocol (`ready`, `stop`, `done`, `finished`, `pending`, `inflight`, `head`/`tail`, `exiting`). Then classify each hit:

- **Hand-written protocol**: a hand-over, a bounded pipeline, a work queue with ordered output, shutdown or close, a fatal-error or cleanup lifecycle, a retry or lease loop. Model it.
- **Data-parallel loop** over disjoint indices: not a protocol. Leave it to the sanitizer.
- **Library-owned** (a channel, an executor): model only the code around it.
- **Sequential arithmetic the protocol or the output depends on** (slot and splice indices, window bounds, a size computed one way and checked another, an encoder with a decoder): a Lean target (step 4). Also grep for `%`, `- 1`, `+ 1`, `>>`, `overlap`, `splice`, `offset` near the protocol's data.

Write the protocol table before modelling: one row per protocol with its actors (threads), shared variables, every wait and what wakes it, the terminal states (joined, exited, closed), and the resources whose ownership moves (slots, buffers, file handles, the thing `close` frees). The rows with a wait that has no escape, a resource freed by two paths, or an error raised on a thread other than the one that reports it go first. Read the whole file for each protocol you model; a brief that paraphrases the code teaches the model the paraphrase.

## 2. Model one protocol per agent

Spawn one strongest-judgment agent per protocol, in parallel, with the brief below. Each writes `tla/<Name>.tla` beside the code and checks it before reporting. Keep the model inside the agent; the main thread gets the report.

The brief names: the files and line ranges, the actors and shared variables from the table, and these rules of shape.

- One step per critical section under the mutex, plus one step for each unlocked phase (build, parse, consume). An explicit `lock` variable when more than one lock-acquire can race.
- A program counter per thread. A condition-variable wait is a pc value in the wait set; only a broadcast, a signal, or a spurious wakeup leaves it, and the woken thread retakes the mutex and rereads the state before it acts. Spurious wakeups are unfair steps. This encoding makes a lost wakeup a liveness violation, never a TLC deadlock, so say so in the header and check liveness.
- Resource ownership as a variable: every slot or buffer is in exactly one of free, each queue, or a thread's hands. Every produced item is in the consumer's record, in the hand-over variable, or freed.
- When control can leave a critical section without running its unlock (`longjmp`, an exception, a panic, `exit()` from a handler), model the mutex's owner and what the thread's live frames believe they hold as two variables. They diverge exactly when an unwind leaks a lock, and a later acquire by any thread then blocks forever; without the split the model unlocks for free and the hang is invisible. Also list every allocation and exit call that can run under each lock, since an out-of-memory exit under a lock is the usual way in.
- The consumer is nondeterministic: it may call `next` any number of times, call `close` from any idle point (before the first call, after the last item, after an error), and stop calling. The producer may fail at any item when the code has a failure path (`FailAt` as a constant set).
- Constants small and at the boundary: the shipped slot count and 1 and 2; items 0, 1, 3, 5; one, two and three workers.
- Properties: `TypeOK`; the ownership partition; order of delivery; no delivery after end or error; the documented error-ordering guarantee; no double free and no leak at `closed`; and the liveness set: every blocking call returns, `close` terminates from every state it can be called in, a run without `close` reaches the end. Weak fairness on every thread step except the consumer's choices and the spurious wakeups. Strong fairness on a mutex acquire only when a counter-example is pure starvation by a spuriously waking peer, and name that assumption in the spec.
- Mutation check before reporting a pass: mutate the spec the way a C bug would (an `if` for a `while`, a missing broadcast, a stack for a FIFO, a flag not cleared, a take without a remove) and record which property each mutant fails. A property no mutant fails is not yet a check.
- Report: file paths, the exact TLC command per configuration, a table of states and verdicts, each counter-example as the sequence of code events with `file:line`, the agent's judgment of reachability and which constraint of the real code the model lacks, and the properties it could not express.

## 3. Read the counter-example back into the code

For each violation, in this order:

1. `tlc-trace.py tlc.log`. Walk the steps and write the code event for each, with the line number. The trace is the bug report; the model's variable names are not.
2. Decide reachability against the real constants and the real callers. A violation at `Slots=1` in code shipping `Slots=4` is a latent dependency, not a hang; say which, and keep the boundary configuration in the matrix either way.
3. Reproduce in the code when the trace is reachable: a deterministic unit test that forces the interleaving (a hook, a small slot count, a barrier), a sanitizer run, or a stress loop with the counts from the trace. When no cheap reproduction exists, say so and let the model plus the fixed configuration carry the proof.
4. Fix the smallest thing the trace needs, mirror the change in the spec, rerun the whole matrix. The spec and the code are one change.
5. One PR per bug. Land the spec, the matrix entry and the fix together, with the state counts and the mutant table in the body.

## 4. Lean for the sequential core

One agent per target, same as the TLA+ step, with this brief. Start from a copy of [`examples/lean-template/`](examples/lean-template/Model.lean): a `lakefile.toml`, a pinned `lean-toolchain`, no Mathlib unless the arithmetic needs it (a Mathlib dependency turns a ten-second build into an hour without the cache).

1. **Transcribe, do not paraphrase.** Write the state type and each function from the code with the same arithmetic: the same integer width (`UInt32`, `Int` with explicit bounds, `Nat` only when the code cannot go negative), the same rounding and division, the same order of operations. Name the functions after the code's functions and cite `file:line` in a doc comment. A model that fixes the bug while transcribing proves nothing about the code.
2. **State the property as a `Prop` with a `Decidable` instance.** The invariant a transform must keep, the round trip an encoder and decoder must close, the bound an index must respect, the set of states a machine must never reach.
3. **Search before you prove.** Write a bounded exhaustive check as an executable (`badPairs` in the template: every state up to a size from which one step breaks the property) and `#eval` it. A non-empty list is the counter-example, with concrete values, in seconds. Set the bound above every constant the code uses (the slot count, the batch size, the window) so the boundary cases are inside it.
4. **Prove for every size.** One theorem per step or function, by cases on the guards, closed with `simp only [...]` to expose the arithmetic and `omega` (or `decide` on a finite type). Leave `sorry` only where the proof needs a fact about the real code the model lacks, and name that fact in the comment; `lean-check.sh` lists every `sorry` as a FAIL, so the gap stays visible.
5. **Mutate.** Change the model the way the bug would (`<` for `≤`, a missing `+ 1`, a swapped argument) and confirm the bounded search finds it and the theorem stops closing. A property no mutation disturbs is not yet a check.
6. **Report** the counter-example as concrete inputs to the code's function, the `file:line` of the arithmetic it exposes, a unit test that feeds those inputs, and the fix. A closed proof reports which assumptions it rests on (the integer widths, the bounds taken as hypotheses).

## 5. Keep the proof

TLA+: add the specs to CI through `tlc-matrix.sh` with a matrix file beside them ([`examples/template.matrix`](examples/template.matrix) shows the three directives). Lean: keep the lake project in the repo and run `lean-check.sh <dir>` in CI; pin the toolchain. Each model's header comment names the code it models with line numbers; refresh those when the code moves. Record in the project's testing doc what each model checks and which configuration is the boundary.

## What this does not cover

Memory-model ordering below the mutex is outside every model here; keep the sanitizer. Floating-point results are modelled as the integers they round to, never as reals, unless the property is about the rounding itself. A model that passes shows the part as modelled is correct; the gap between the model and the code is exactly the list of "what the model lacks" and the hypotheses of the theorems in each report, so read those before trusting a pass.

## Reply

The protocol table with a verdict per row; for each counter-example the code events, reachability, the reproduction and the fix with its PR link; the matrix command and its PASS count; the properties that could not be expressed. Every verdict carries its state count or its mutant table.
