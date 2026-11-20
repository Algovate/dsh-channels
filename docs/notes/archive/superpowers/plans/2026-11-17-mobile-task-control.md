# Mobile Task Control Implementation Plan

> **For agentic workers:** Execute in this session using the existing runtime and test harness.

**Goal:** Let phone users see, stop and clear their channel tasks without affecting desktop work.

**Architecture:** Keep queued messages in the existing inbox. Track the current and latest task separately, with a private cancellation controller per running task. Persist task summaries so interrupted execution is shown as unknown after restart. Continue using the driver's existing ownership checks.

**Tech Stack:** TypeScript, Node.js, node:test; no new dependencies.

**Spec:** Product scope agreed in this chat: P0 receipt acknowledgement, execution and delivery status, `/cancel`, `/clear`, sender ownership in groups.

## Global Constraints

- Keep deny-by-default gates and once-only approvals.
- `/cancel` captures only the current task; `/clear` captures only queued messages already present, restricted to the sender in groups.
- A cancellation request is not proof of termination or rollback.
- Replay only unstarted inbox messages. Preserve artifacts and report unknown execution after interruption.
- Deliver acknowledgements only after durable acceptance; never block execution on a stalled acknowledgement.

## Review Focus

- Clearing must persist before reporting success, prevent replay and release reserved quota.
- Cancellation while awaiting approval must withdraw prompts without cancelling desktop work.
- Same-chat queued work and other chats must survive cancellation.
- Failed or unconfirmed delivery must not turn successful execution into execution failure.
- Restart and state write failure must never report interrupted work as completed.

### Task 1: Phone controls and task lifecycle

**Files:** `packages/core/src/runtime.ts`, `commands.ts`, `store/inbox.ts`, `store/tasks.ts`, `store/layout.ts`, `turns.ts`, `turn-progress.ts`; `test/mobile-tasks.test.ts`.

- [x] Write runtime tests for acknowledgement, live status, cancellation isolation, group ownership, clearing and restart.
- [x] Run tests and confirm missing behavior fails.
- [x] Implement task persistence, selective controls and truthful status using existing inbox and driver.
- [x] Run focused tests; update existing expectations for receipt notices.

### Task 2: Documentation and verification

**Files:** `README.md`, `docs/DESIGN.md`, `docs/OPERATIONS.md`, `docs/STATUS.md`, `CHANGELOG.md`.

- [x] Document commands, cancellation limits, durable task state and validation scope.
- [x] Run `npm test` and `git diff --check`; review lifecycle and trust boundaries.

## Validation evidence

- Baseline: 265 tests passed.
- Added 18 mobile task tests; full suite: 283 passed, 0 failures.
- Independent review identified atomic clear receipts and a completion/cancellation race; both reproduced with failing tests and fixed.
- Real DSH, Weixin and Telegram validation remains explicitly outside this simulated-host verification.
