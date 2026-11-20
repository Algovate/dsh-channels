# Channel schedule results Implementation Plan

> **For agentic workers:** Use executing-plans inline and request one final fresh-context review.

**Goal:** Create channel-owned native DSH schedules and return their completed text results to the originating chat.
**Architecture:** The native schedule service owns timing and execution. Each channel schedule has a dedicated existing Session and a persisted binding/creation intent. Local commands only manage owned bindings. A relay reads native delivery receipts plus persisted Session events, folds only the matching message's turn, and durably saves outgoing results before transmission. No model turn is replayed by this plugin.
**Tech Stack:** TypeScript, existing atomic JSON and TurnProgress, structural optional host services.
**Spec:** User selected “实现定时任务回传原聊天”.

## Global Constraints

Commands: /schedule after <minutes> <prompt>, /schedule every <minutes> <prompt>, /schedules, /schedule pause|resume|delete <local-id>. Minutes are positive safe integers up to one year. Bind original channel/account/chat/sender and configured project cwd; group management is sender-scoped. Never enumerate arbitrary host schedules in a channel. Native schedule service, session persistence and resolve-agent hook must be present; otherwise explain unavailability without model work. Native host dependencies are absent on mini; deployment is outside this turn.

Persist creation intent before native creation; reconcile unknown create outcome by the unique target Session, never retry create blindly. Revalidate permissions and original project at native activation and before result delivery. Corrupt binding state blocks owned schedule activation and mutations. Only dedicated chan-schedule-* Sessions are relay-owned. First version returns final text and failure notices; scheduled attachments and interactive prompts stay on desktop. Normal /cancel and turn quotas continue to describe ordinary channel tasks; a recurring schedule is explicit ongoing native authorization. Pause/delete do not cancel a native occurrence already running. At-least-once notification: an uncertain send may repeat, but tools never rerun.

## Review Focus

Unknown create outcome, stale native target reassignment, group/other-chat isolation, native receipt versus completion, partial progress recovery, scoped read handles, outbox handoff and duplicate sends.

### Task 1: Native ownership and commands
- [x] Add failing tests for command parsing, optional capability absence, original route ownership and creation persistence failure.
- [x] Add schedule binding state and native service bridge; implement intent recovery and owned-only management.
- [x] Gate owned Session activation against live permissions/project and immutable native destination.

### Task 2: Durable result relay
- [x] Test native receipts without execution, matching completion/failure, unrelated turns and restart recovery.
- [x] Persist incremental TurnProgress state, pending notifications and acknowledged outbox handoff.
- [x] Bound schedules, reads and output size; restore adapter routing context only for original targets.

### Task 3: Runtime and documentation
- [x] Register commands and optional activation hook; start/stop relay polling with plugin lifecycle.
- [x] Document setup, native prerequisite, syntax, scope, recovery, desktop interactions and text-only results.
- [x] Run full tests, fresh review, fixes and final clean verification.
