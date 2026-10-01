---
name: formal-verify
description: "Model-check a codebase's hand-written thread protocols with TLA+ and TLC: pick the race-prone parts (hand-overs, pipelines, shutdown, error lifecycles), model each one, prove the properties or get a counter-example, map the counter-example back to a line-level reproduction and a fix, and keep the model in CI. Use for /formal-verify, 'formally verify', 'model-check this', 'TLA+ this', 'find the race conditions', or when a concurrency bug cannot be reproduced by running the code."
---

# Formal verify

**Model the protocol, not the program. TLC exhausts every interleaving of a small instance; a counter-example is a line-level bug report, and a pass is evidence only when every property kills a mutant.**

Tooling: Java and `tla2tools.jar`. [`scripts/tlc-matrix.sh`](scripts/tlc-matrix.sh) downloads the pinned jar, runs a matrix of constants and prints one PASS or FAIL line per run with its state count; [`scripts/tlc-trace.py`](scripts/tlc-trace.py) reduces a counter-example to what each step changed. On macOS `/usr/bin/java` is a stub that prints "Unable to locate a Java Runtime" and some scripts still exit 0 after it, so set `JAVA=/opt/homebrew/opt/openjdk/bin/java` (or your JDK) and check that at least one PASS line printed.

## 1. Pick the targets

Grep for the primitives (`pthread_cond`, `pthread_mutex`, `atomic_`, `std::condition_variable`, `sync.Cond`, `chan`, `select`, `asyncio.Condition`, `Semaphore`, `atexit`, `setjmp`) and for state names that smell like a protocol (`ready`, `stop`, `done`, `finished`, `pending`, `inflight`, `head`/`tail`, `exiting`). Then classify each hit:

- **Hand-written protocol**: a hand-over, a bounded pipeline, a work queue with ordered output, shutdown or close, a fatal-error or cleanup lifecycle, a retry or lease loop. Model it.
- **Data-parallel loop** over disjoint indices: not a protocol. Leave it to the sanitizer.
- **Library-owned** (a channel, an executor): model only the code around it.

Write the protocol table before modelling: one row per protocol with its actors (threads), shared variables, every wait and what wakes it, the terminal states (joined, exited, closed), and the resources whose ownership moves (slots, buffers, file handles, the thing `close` frees). The rows with a wait that has no escape, a resource freed by two paths, or an error raised on a thread other than the one that reports it go first. Read the whole file for each protocol you model; a brief that paraphrases the code teaches the model the paraphrase.

## 2. Model one protocol per agent

Spawn one strongest-judgment agent per protocol, in parallel, with the brief below. Each writes `tla/<Name>.tla` beside the code and checks it before reporting. Keep the model inside the agent; the main thread gets the report.

The brief names: the files and line ranges, the actors and shared variables from the table, and these rules of shape.

- One step per critical section under the mutex, plus one step for each unlocked phase (build, parse, consume). An explicit `lock` variable when more than one lock-acquire can race.
- A program counter per thread. A condition-variable wait is a pc value in the wait set; only a broadcast, a signal, or a spurious wakeup leaves it, and the woken thread retakes the mutex and rereads the state before it acts. Spurious wakeups are unfair steps. This encoding makes a lost wakeup a liveness violation, never a TLC deadlock, so say so in the header and check liveness.
- Resource ownership as a variable: every slot or buffer is in exactly one of free, each queue, or a thread's hands. Every produced item is in the consumer's record, in the hand-over variable, or freed.
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

## 4. Keep the proof

Add the specs to CI through `tlc-matrix.sh` with a matrix file beside them ([`examples/fast-beagle.matrix`](examples/fast-beagle.matrix) is a full one). Each spec's header comment names the code it models with line numbers; refresh those when the code moves. Record in the project's testing doc what each model checks and which configuration is the boundary.

## What this does not cover

Data-flow and state invariants of sequential code (a parser, a schema, an arithmetic kernel) are a theorem-prover job, Lean or a property-based test, not TLC. Memory-model ordering below the mutex is outside every model here; keep the sanitizer. A model that passes shows the protocol as modelled is correct; the gap between the model and the code is exactly the list of "what the model lacks" in each report, so read that list before trusting a pass.

## Reply

The protocol table with a verdict per row; for each counter-example the code events, reachability, the reproduction and the fix with its PR link; the matrix command and its PASS count; the properties that could not be expressed. Every verdict carries its state count or its mutant table.
