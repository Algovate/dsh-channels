# Simplify channel flow Implementation Plan

> **For agentic workers:** Execute inline using executing-plans and request one fresh final review.

**Goal:** Simplify the recently repaired channel flow while preserving its reliability guarantees.
**Architecture:** Put Telegram polling, ordered acknowledgement, bounded handoff and retry scheduling behind one concrete run function. Keep message enrichment in the adapter. Make turn progress reads and attachment caching consistent through small private methods, without adding a generic queue or cache framework.
**Tech Stack:** TypeScript, Node test runner.
**Spec:** User “refactor”, following the whole-review fixes.

## Global Constraints

Work on the current branch without discarding existing uncommitted fixes or .DS_Store. Preserve command bypass, per-chat ordinary FIFO, two global work slots, continuous-prefix acknowledgement, cancellation, quotas, original route snapshots, file snapshots and ownership. No commit, push or deployment.

## Review Focus

Stable enriched message identity across durable retry, partial attachment failures, stopping a pending loop, and release of owned handles only when safe.

### Task 1: Telegram polling module
- [x] Add a failing regression for retrying an enriched message without downloading it again.
- [x] Extract concrete polling logic; name the acknowledgement, handoff and wake steps.
- [x] Keep enrichment and platform sending in the adapter; normalize each input once.

### Task 2: Turn and runtime clarity
- [x] Consolidate incremental progress reads and attach completion logic.
- [x] Remove non-null assertions from inbox snapshotting and redundant routing options types.
- [x] Run full tests and update design docs.

### Task 3: Review and verify
- [x] Run a fresh review, address findings and verify clean build/test/pack output.
