# Remove Legacy Channel Paths Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. The user explicitly requested planning and implementation in this session.

**Goal:** Remove the old adapter ingress API and opt-in output-directory scanning mode while preserving durable ingress and safe file delivery.

**Architecture:** Make `ChannelAdapter.startWithSink(sink: IngressSink): Promise<void>` the only startup API. File delivery continues through `present` events and standalone local Markdown images, captured into private task directories with existing validation and retries.

**Tech Stack:** TypeScript, Node.js >=22.13.0, node:test, npm workspaces.

**Spec:** The preceding code review, recommendations 1 and 2, and the user's “plan and impl” instruction. Other feature reductions are deferred.

## Global Constraints

- Preserve authorization, ordering, durable handoff, retry, cancellation and recovery.
- Preserve artifact indexes, private snapshots, safe path checks and resend.
- No new dependencies; no publish, deployment or automatic commits.
- Historical state outputDirectory fields remain readable.

## Review Focus

- Old third-party adapters must be rejected clearly before registration/polling.
- Repeated start and stop/restart must retain adapter lifecycle behavior.
- Failed durable handoff must retain provider updates and downloaded media.
- An old config containing legacyOutputScan must not re-enable directory instructions.
- Unrelated workspace files must never become undeclared attachments.

### Task 1: Unify adapter ingress

**Files:** core types/index; both adapter index files; adapter contract, lifecycle, handoff and startup tests; runtime test helper; docs/ADAPTERS.md.

**Interfaces:** Require startWithSink; retain stop/send/restoreInbound/edit/typing. Remove start/onInbound, deprecated capability flags, Outgoing.bubbles and adapter interaction rendering types.

- [x] Add a startup regression rejecting a legacy-only adapter; run it and observe failure.
- [x] Validate the required sink entry before registration; remove the core fallback and adapter handler sets.
- [x] Migrate all test consumers to sink.offer, retaining lifecycle and failed-handoff assertions.
- [x] Run build and adapter/startup tests; document the API migration.

### Task 2: Remove legacy output mode

**Files:** core config/runtime/turns; legacy-output tests; docs/OPERATIONS.md, docs/STATUS.md, CHANGELOG.md.

**Interfaces:** Remove config.legacyOutputScan and TurnRequest.outputDirectory; retain deliverFiles, task outputDirectory, scanner and artifact storage APIs.

- [x] Add a regression loading old config: input requests present, no turn directory is precreated, and an undeclared file is not sent. Observe failure before implementation.
- [x] Remove legacy instructions and per-turn directory creation/cleanup; keep current safe capture and recovery.
- [x] Migrate security/snapshot/index-failure tests to declared deliverables; retain meaningful assertions.
- [x] Run npm test, npm run pack:check and git diff --check; review the full diff and update this plan's execution record.

## Execution Record

- Baseline: 460 tests passed during the preceding review; clean tracked working tree at implementation start.
- Ruling: Work in the shared checkout and execute directly, as authorized by the user; no additional approval flow, worktree, commits or feature removals.
- Pre-flight: Both tasks touch core startup/contracts indirectly through test fixtures; artifact persistence schemas and scanner APIs remain unchanged.

- Task 1: RED observed legacy subscription invocation instead of the required-entry rejection. GREEN: 48 adapter/startup tests passed; both drivers and all test consumers use sinks.
- Task 2: RED observed the old directory instruction with legacy config. GREEN: full npm test passed, 462 tests; legacy security/index/snapshot coverage migrated to declared outputs.
- Ruling: Removed the now-unneeded outputDirectory parameter from the internal artifact planner, while retaining persisted task indexes and bounded private-directory scanning.
- Final verification: npm test → 463 passed; npm run pack:check → all three packages passed; git diff --check → clean.
- Independent review: no blocking runtime defect. P2 stale design/device-checklist documentation fixed; P3 distinct-sink lifecycle coverage added to Telegram and existing Weixin tests. Historical redesign/status descriptions marked superseded.
- No commit, publication, deployment or real-account send performed.

- Follow-up: user requested “proceed”; prepare a local commit on the existing branch after fresh full-suite, packaging and diff verification. Publication and deployment remain outside this step.
