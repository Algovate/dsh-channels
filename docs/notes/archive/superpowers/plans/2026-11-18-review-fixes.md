# Whole-repository reliability fixes Implementation Plan

> **For agentic workers:** Use executing-plans inline and requesting-code-review for a fresh final review.

**Goal:** Resolve the eight findings from the whole-repository review.
**Architecture:** Centralize route decisions in a small routing module, distinguish missing from corrupt state, separate bounded Telegram handoff scheduling from ordered provider acknowledgement, preserve attachment errors explicitly, reuse validated file snapshots, and bound idle agent ownership with incremental event reads.
**Tech Stack:** TypeScript, Node test runner, existing atomic JSON stores.
**Spec:** User instruction “fix all” following whole-repository review, 2026-11-18.

## Global Constraints

Preserve default session IDs, route migration, original-chat delivery, quotas, FIFO of ordinary inputs and durable acknowledgement. Preserve corrupt files. Do not replay started turns or dispose host-owned handles. Keep .DS_Store untouched. No real messages, deployment or push in this task.

## Review Focus

Error propagation before durable handoff; corrupt state; control overtaking without cursor loss; media-only failures; inode/path replacement; active handle eviction and incremental event offsets.

### Task 1: Durable input, configuration and outbox
- [x] Add failing regressions for unavailable routes and corrupt config/outbox.
- [x] Centralize route selection/validation and preserve retry semantics.
- [x] Fail closed for invalid critical state without overwriting files.

### Task 2: Adapter handoff and attachment failures
- [x] Test slow Telegram attachments, control bypass, acknowledgement rewind and bounded work.
- [x] Implement ordered acknowledgement plus bounded dispatch; report failed attachments and avoid empty model turns.

### Task 3: Shared output snapshots and session lifecycle
- [x] Test automatic output immutability/cleanup, idle owned handle release and incremental event reads.
- [x] Reuse artifact snapshots, remove unused internal compatibility interfaces, bound idle ownership and scan only new events.

### Task 4: Documentation and review
- [x] Update docs, run full tests and fresh review; fix findings and verify final tree.
