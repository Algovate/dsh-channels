# Durable delivery and restart recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Persist replies before sending and recover completed host turns after a restart without rerunning tools.

**Architecture:** Extend the existing canonical state document and HostPort implementation rather than replacing the in-progress redesign. Outbox owns durable text progress and per-chat serialization. Tasks retain the exact host input identity; recovery reads session persistence and uses the same completion path as live execution.

**Tech Stack:** TypeScript, Node.js >=22.13.0, node:test, existing schemastery and atomic JSON state.

**Spec:** docs/REDESIGN.md and the preceding chat's redesign proposal.

## Global Constraints

- Preserve the existing uncommitted work; work on the current codex branch, without committing or deploying unrelated edits.
- Keep deny-by-default authorization, exact input/turn ownership, private file snapshots, per-chat order and unconfirmed platform acceptance.
- Never resubmit a started host input during recovery.
- Retain the existing legacy mirror compatibility for this release; do not introduce another storage backend alongside state.json.
- Platform I/O is outside local transactions; unknown acknowledgments can produce duplicate delivery.

## Review Focus

- A process stops during the first send: the complete unsent reply must already be durable.
- A successful part cannot be committed: stop sending subsequent parts and keep recoverable progress.
- Concurrent replies and retry timers: the same chat cannot overtake or send the same entry concurrently.
- A restart reads desktop/other-turn output: only the persisted input identity may produce a recovered reply.
- Permission or project changes during session reads: revalidate before committing or sending recovered output.

### Task 1: Durable text egress

**Files:** packages/core/src/store/outbox.ts, packages/core/src/runtime.ts, test/durable-delivery.test.ts.

**Interfaces:** Outbox.enqueue(target, text parts, taskId) commits a ready entry; Outbox.drain(send, selection?) owns serialization and per-part commits. Existing Outbox.add remains compatible with retry fixtures.

- [x] Write failing tests for persisted-before-send, refusal on persistence failure, partial progress, concurrent sends and restart recovery.
- [x] Implement queued-first replies and shared immediate/timer draining; preserve notices and interactions as immediate traffic.
- [x] Run targeted tests, then npm test; resolve behavior regressions rather than weakening safety assertions.

### Task 2: Exact host input recovery

**Files:** packages/core/src/turns.ts, packages/core/src/store/tasks.ts, packages/core/src/store/schema.ts, packages/core/src/runtime.ts, test/task-recovery.test.ts.

**Interfaces:** TurnRequest.beforeSubmit(binding) persists sessionId/messageId/beforeSeq before followup; TurnDriver.recover(binding, signal) only reads the host log. TaskRecord stores the original inbound route and binding; Tasks.recoverable() lists unfinished submissions. A shared runtime completion method handles live and recovered results.

- [x] Write failing tests for completed-log recovery, wrong-turn exclusion, unavailable/unfinished logs, revoked access, and binding-write failure preventing followup.
- [x] Persist the binding before submitting; recover incrementally with bounded reads, exact cwd verification and cancellation on disposal.
- [x] Reuse artifact capture, task completion and durable egress; clear recovery metadata only after durable handoff.
- [x] Run targeted tests and npm test.

### Task 3: Document and verify

**Files:** docs/DESIGN.md, docs/REDESIGN.md, docs/STATUS.md, CHANGELOG.md.

- [x] Document queued-first text, started-turn reconciliation, compatibility and limits (files use the existing artifact index/manual resend; mirror migration remains separate).
- [x] Run npm test and npm run pack:check; inspect the final diff for accidental changes and authorization regressions.
- [x] Record actual results and remaining real-platform validation; leave changes reviewable in this workspace.

## Execution record

- Continued in the existing `codex/schedule-authorization-audit` workspace with all pre-existing uncommitted changes preserved. No commits, pushes or deployment.
- Baseline: 394 passing tests. Final: `npm test`, 421 passing, zero failures; `npm run pack:check`, all three packages pass; `git diff --check`, clean.
- Implemented `StateFile.writeMany`, atomic recovery-to-outbox handoff and atomic per-part task receipts. This is the transaction primitive the existing JSON redesign lacked.
- Independent review required protecting pending task attribution, retaining complete recovery text, marking indexed files unsent before text handoff, atomically retaining uncertainty and preserving a blocked recovery binding. Added failing regressions, then fixes; all included in the final suite.
- One full-suite failure exposed a pre-existing approval timeout identity race. Added a deterministic delayed-expiry regression; `retire(entry, notice)` now preserves the original entry identity.
- Compatibility mirrors and manual artifact resend remain intentional release constraints. Real host/platform recovery acceptance is not established by the simulated suite.
