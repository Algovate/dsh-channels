# Schedule authorization audit Implementation Plan

> **For agentic workers:** Use executing-plans inline and requesting-code-review for final verification.

**Goal:** Close authorization and shutdown gaps in queued native schedule operations.
**Architecture:** Keep channel/account management authorization separate from original project execution authorization. Recheck the current permission before queued command execution and after awaits at mutation or activation boundaries.
**Tech Stack:** TypeScript, existing schedule fixture and Node test runner.
**Spec:** Default follow-up review and fixes after completed three-part roadmap, with a pending optional scope choice.

## Global Constraints

Preserve read-only native execution tracking and original-chat delivery. Revoked queued commands must not create/edit tasks. Removed projects must not prevent an otherwise authorized owner from deleting their plan. No push/deploy or real account messages in this iteration.

## Review Focus

Queued command revocation, creation-session setup awaits, activation continuing after disposal, and sender revocation during service waits.

### Task 1: Regression and fixes
- [x] Observe failing tests for queued command revocation and disposed activation.
- [x] Introduce shared account permission check and revalidate at asynchronous mutation/activation edges.
- [x] Verify native ownership and project rules remain effective.

### Task 2: Review and verification
- [x] Update docs, run full suite and fresh review.
- [x] Address findings; clean build/tests/pack checks and report status.
