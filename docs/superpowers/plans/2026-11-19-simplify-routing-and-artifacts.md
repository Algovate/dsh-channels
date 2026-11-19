# Simplify Routing and Artifact Delivery Implementation Plan

> **For agentic workers:** Use executing-plans task-by-task in the existing checkout. User requested continuing simplification until further cuts no longer justify their cost.

**Goal:** Remove mobile historical-session selection and redundant artifact discovery, then assess whether any remaining proposed cut has a demonstrated net benefit.

**Architecture:** Keep project selection and /new with the existing persisted current/max allocation to preserve old session identities. Retired session commands return a small migration notice without invoking a model or quota. Build artifact indexes from successfully captured filenames; delivery reads the saved index directly rather than rediscovering files with a filesystem scan.

**Tech Stack:** TypeScript, Node.js >=22.13.0, node:test, npm workspaces.

**Spec:** Original simplification review recommendations, prior legacy-path plan, and user instruction “继续处理精简 直到没必要”.

## Global Constraints

- Preserve approvals, authorization, durable delivery, restart recovery and artifact safety.
- No state schema version migration or loss of existing selected sessions, high-water allocation, historical indexes or queued bindings.
- Keep /new and project selection. No new dependencies or publishing/deployment.
- Preserve current branch and PR; commit/push follow verified implementation as already authorized.

## Review Focus

- Removed commands, including Telegram @bot suffixes, must never turn into model tasks or bypass sender authorization.
- Old selected session current < max must survive restart; /new must allocate max + 1.
- A queued input keeps its original project/session when /new or project selection changes.
- Recovery must honor indexed dotfiles, .log files and nested paths without discovering unindexed files.
- Failed/missing/oversized/symlinked artifacts and configured count limits must remain visible as incomplete delivery.

### Task 1: Retire historical session controls

**Files:** commands.ts, runtime.ts, routing.ts; commands/session-routing tests; README and current operations/design docs.

**Interfaces:** ChannelRoutes.command accepts projects|project|new. Parser retains session/sessions only as hidden retired controls handled by the runtime.

- [x] Add a regression: /help omits both retired commands; each old command returns migration guidance, starts no host turn and does not spend a turn quota. Observe failure.
- [x] Replace the session list/selection branches with the retired notice; retain current/max persistence for old selections and monotonic /new allocation.
- [x] Seed old current=0,max=1 state in restart tests instead of calling the retired selector. Preserve project isolation and queued-route tests.
- [x] Run focused commands/owners/groups/session-routing tests; update docs.

### Task 2: Use captured artifact indexes directly

**Files:** task-artifacts.ts, artifacts.ts; delete produced.ts and its obsolete scanner-only tests; task-artifacts/reliability tests; current docs.

**Interfaces:** prepareTaskArtifacts retains its current signature. copyDeliverable returns the captured relative filename; describeArtifact validates indexed bytes for delivery. No scanner/captureArtifacts discovery API remains.

- [x] Add failing regressions: recovered .log and nested/dotfile indexes deliver, unrelated files are ignored, and excess declared files respect the shared 100-file persistence bound with an explicit incomplete notice.
- [x] Record copyDeliverable's successful filenames as the sorted stable index; build delivery from indexed paths, bounded by maxFiles and checked through describeArtifact with the authorized working directory.
- [x] Preserve incomplete flags/notices and existing recovery indexes; remove directory traversal/time/extension filtering and scanner-only tests.
- [x] Run focused artifact/media/durable-recovery tests, full Node 22 and Node 24 suites, pack:check and diff checks.

### Task 3: Stop at the justified boundary

- [x] Reassess schedules, document extraction, fallback polling, counter backends, live settings and command merging against actual dependencies and migration costs.
- [x] Record remaining decisions and independent review; fix actionable findings and verify locally. Commit/push and both PR CI jobs follow this local verification.

## Execution Record

- Baseline: clean checkout at 4d636de; preceding PR CI passed on Node 22 and Node 24 with 463 tests.
- Pre-flight: Task 1 changes routing commands only; Task 2 preserves task/output persistence interfaces. Neither requires a store schema change.

- Task 1: RED observed retired commands still listed in help; GREEN 22 focused routing/command/owner/group tests. Legacy current=0,max=1 selection survives reopening; /new allocates 2; queued input remains on the original session through /new and project switch.
- Task 2: RED observed recovered .log/dotfile indexes omitted and a 101-file planner truncated to 100. Directory discovery replaced with captured-name indexes and safe indexed reads; 70 focused artifact/delivery/recovery tests passed before further boundary coverage.
- Ruling after independent review: the task, outbox and recovery schemas all intentionally bound files at 100. Instead of expanding the durable protocol to match an unsupported 10,000 config bound, share MAX_PRODUCED_FILES=100 across config/schema/recovery, reject out-of-range config through existing default fallback semantics, and test 100-file persistence/restart/resend. This changes unsupported >100 settings to the default 3; no persisted schema/value changes.
- Configuration RED: maxProducedFiles=101 incorrectly remained 101; GREEN after bound alignment. Added recovered outside-workspace rejection and count/byte-limit coverage. All 35 focused artifact/media/config tests pass, including the 100-file durable restart/manual resend test.
- Remaining features evaluated in docs/SIMPLIFICATION-2026-11-19.md; no further justified feature deletion identified under the current requirements.
- Review follow-up: a 101st host-declared file was silently lost during incremental replay. RED reproduced missing overflow state; added an optional deliverablesIncomplete cursor/reply flag and propagated it into task index incompleteness/notices. A regression persists the cursor, disposes the runtime, clears the state cache, finishes the host turn and verifies 100 uploads with failed/incomplete delivery state. Existing records remain readable without a version migration.
- Independent final review approved the overflow fix and backward-compatible optional cursor field; no remaining blocker.
- Final local verification: Node 22 and Node 24 each passed 464 tests with zero failures/cancellations; all three package checks and git diff --check passed. Seven scanner-only tests were removed and eight behavior/boundary tests added. A clean rebuild confirmed no obsolete produced module remains in generated outputs.
- Delivery follows on the existing branch/PR; no merge, publication or deployment is requested.
