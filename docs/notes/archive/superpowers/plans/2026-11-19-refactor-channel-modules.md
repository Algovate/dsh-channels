# Channel Module Refactors Implementation Plan

> **For agentic workers:** Execute task-by-task in this checkout with executing-plans; the user explicitly requested implementing all six review candidates.

**Goal:** Implement all six behavior-preserving refactors from the preceding review.

**Architecture:** Remove the unused outbox insertion interface; define shared live-settings types/validation; extract bounded descriptor copying and read-only session paging; share browser JSON POST mechanics; move outbound coordination behind a Delivery module. Keep existing persistence layouts and policy decisions.

**Tech Stack:** TypeScript, Node.js >=22.13.0, node:test, existing npm workspaces. No new dependencies.

**Spec:** User's “fix all” instruction applies to the six candidates in the preceding review. No feature cuts, merge, deployment or production configuration changes are included.

## Global Constraints

- Preserve send results, errors, authorization rechecks, cancellation, backoff, ordering and 100-file limits.
- Keep task/outbox handoff and delivery-progress commits atomic through Tasks.
- Preserve file containment, inode checks, private snapshots and failure cleanup.
- Keep approval/question outcome policies and limiter window semantics separate.
- Use a feature branch in the current clean checkout; leave main and mini untouched.

## Review Focus

- Enqueued test messages must exercise real send failures when testing delayed retry; queue-only fixtures need no simulated failures.
- Settings must preserve omitted/undefined fields, reject invalid values and persist before live updates.
- Bounded copies must reject growth/empty sources and retain wrapper-specific cleanup.
- Shared session paging must preserve cancellation, read budgets, cursor matching and guaranteed handle closure.
- Delivery extraction must preserve adapter identity checks after awaits and task/outbox atomic commits.

### Task 1: Retire Outbox.add

**Files:** store/outbox.ts; all test callers of Outbox.add.
**Interfaces:** enqueue/sendPending/drain remain; add is removed.
- [x] Migrate fixtures to enqueue; retry-delay tests use enqueue plus a failed sendPending.
- [x] Run outbox/delivery regression tests as characterization checks, then remove add and rerun.

### Task 2: Shared live settings

**Files:** new src/live-settings.ts; runtime.ts, status.ts, index.ts; settings tests.
**Interfaces:** LiveSettings, LiveSettingsPatch, parseLiveSettingsPatch(raw), liveSettings(config), applyLiveSettings(config,patch). Config retains existing default/normalization behavior.
- [x] Add validator tests for numeric bounds, non-integers, booleans, omitted keys, unknown keys and empty patches; observe failure before implementation.
- [x] Reuse one field definition in validation, snapshots and updates; preserve save-before-update in HTTP route.
- [x] Run settings/management/client tests.

### Task 3: Bounded descriptor copy

**Files:** new src/file-copy.ts; artifacts.ts; new file-copy tests and existing artifact tests.
**Interface:** copyBounded(source, destination, maxBytes): Promise<void> transfers bytes only; callers still own paths, descriptor opening/closing and temporary-file cleanup.
- [x] Test multi-chunk content, empty source and one-byte overflow using real files before implementation.
- [x] Replace both transfer loops with the helper; retain security checks and cleanup.
- [x] Run file-copy/artifact/media tests.

### Task 4: Shared read-only session paging

**Files:** new src/session-reader.ts; schedules.ts, turn-recovery.ts; new session-reader tests and existing recovery/schedule tests.
**Interface:** readSessionEvents(persistence, sessionId, workingDirectory, fromSeq, signal) is an async generator of committed events, capped at 16 reads of 256 events. It validates cwd and closes handles on every exit.
- [x] Test cwd mismatch, cancellation, non-advancing pages, read bounds and early consumer completion before implementation.
- [x] Keep TurnProgress, exact input matching, schedule formatting/truncation and deliverable overflow policy at callers.
- [x] Run reader/schedules/task-recovery tests.

### Task 5: Browser JSON POST helper

**Files:** client.js; client tests.
**Interface:** private postJson(path, body) inside the registered client factory; same-origin JSON requests, consistent response/error handling. Forms retain their own state and success actions.
- [x] Preserve existing form request tests; add response-error coverage where missing.
- [x] Replace three POST implementations; run client/management tests.

### Task 6: Delivery ownership

**Files:** new src/delivery.ts; runtime.ts; delivery/runtime/media/recovery tests.
**Interface:** Delivery owns its Outbox and send/enqueueReply/editCard/retry/dispose mechanics. It receives shared config/tasks/routes/journal/adapters and authorization/schedule policies. Runtime keeps inbound orchestration, task execution and its combined recovery/retry timer.
- [x] Characterize delivery, authorization, persistence, recovery and card behavior with existing tests before moving code.
- [x] Move outbound code, preserving async guard ordering and Tasks atomic commits; retain public runtime.send/outbox/startOutboxRetry compatibility.
- [x] Run focused tests, full Node 22 and 24 suites, clean package checks and independent review. Fix findings before completion.

## Execution Ledger

- Base: e11b22f, clean main checkout; branch codex/refactor-channel-modules.
- Ruling: Existing behavior tests characterize pure moves/deletions; add test-first cases for new shared mechanics rather than tests asserting private source structure or API absence.
- Pre-flight: Tasks 1 and 6 share Outbox.enqueue/sendPending; Task 6 must use the post-removal interface. Tasks 2 and 6 share config by reference. Tasks 3 and 6 retain snapshotDelivery; Task 4 leaves recovery result semantics intact. No persistence version migration.

- Tasks 1–6 complete: removed Outbox.add and migrated all fixtures; shared live settings, bounded descriptor copies and session reads; consolidated browser POST handling; extracted Delivery with public runtime compatibility retained.
- Helper tests: missing-module RED before implementation; validator/copy/paging cases GREEN. Browser tests cover HTTP/application/JSON failures, preserved edits and successful saves.
- Final review: fresh-context gpt-6.2-astra reviewed all tracked and new files against e11b22f. Atomic delivery commits and authorization ordering retained.
- Final: fixed buffered events after cancellation — “session reader stops and closes when aborted between buffered events” RED→GREEN; focused suite 17/17; full suite 468/468 on Node 22 and Node 24.
- Review follow-through: delayed retry fixture now uses a genuine failed sendPending with retryAfterMs rather than editing persisted JSON; pairing documentation restored to its component. These complete fixture/documentation refactoring rather than change production behavior.
- Validation: clean rebuild, Node 22 full suite 468/468, Node 24 full suite 468/468, all three workspace package dry runs, git diff --check. No new dependencies or state schema changes.
- Integration: preserve codex/refactor-channel-modules locally for review; main and mini untouched.
- Ruling cost: existing regressions characterize pure moves/deletions instead of new source-structure tests; an untested existing edge case remains possible, mitigated by targeted helper tests and independent review.
