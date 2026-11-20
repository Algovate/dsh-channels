# Media delivery and one-time state migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Fix generated files not reaching chat, persist attachment delivery with text, and retire live legacy state mirrors safely.

**Architecture:** Keep `present` as the explicit declaration of files to send, and explain that requirement on each channel input. Treat final local Markdown image embeds as explicit image declarations through the same containment checks; this supports existing image skills that do not call present. Report rejected declarations as incomplete delivery. Extend the existing outbox with task artifact references and safe private upload snapshots. Migrate legacy state into one canonical versioned document, archiving originals only after a successful commit.

**Tech Stack:** TypeScript, Node.js >=22.13.0, node:test, existing schemastery and atomic JSON store.

**Spec:** docs/REDESIGN.md; live report and screenshot in this chat.

## Global Constraints

- Preserve all existing workspace changes and deny-by-default, exact turn ownership and workspace containment.
- No broad output-directory scan or upload of bare paths, ordinary source links, URLs, or code examples. Only present declarations and standalone final local image paragraphs enter automatic delivery.
- An attachment retry reuses the indexed task artifact; validate current authorization and take a bounded private snapshot before every upload.
- Do not rerun image generation or agent tools to recover an existing output.
- A migration never overwrites backups or silently imports newer legacy files over canonical state.
- Keep at-least-once delivery semantics and durable unconfirmed receipts.

## Review Focus

- A generated image is linked but not presented: instruct the agent correctly and mark the missing attachment visibly.
- Text succeeds but a file fails or the process exits: keep its file and remaining delivery durable without repeating acknowledged text.
- File paths change, become symlinks, exceed limits, or access is revoked during snapshot creation: fail closed.
- Legacy migration is interrupted or an input file is malformed: preserve originals and refuse partial activation.
- Canonical state exists alongside edited/stale mirrors: canonical wins and old copies become inactive backups.

### Task 1: Channel delivery contract

**Files:** packages/core/src/turns.ts, packages/core/src/runtime.ts, packages/core/src/outbound.ts, related tests.

**Interfaces:** TurnRequest gets a channel-only delivery instruction when autoSendFiles is enabled. A pure helper identifies local Markdown file references for missing-delivery reporting, without opening them.

- [x] Add failing regression reproducing a linked PNG with no present event and false all-sent status.
- [x] Explain `present` on the identified input, preserving the user's original text block and desktop ownership.
- [x] Collect final local image embeds as declared files, deduplicate against present, and report rejected/missing images as incomplete delivery. Ignore code examples and remote URLs.
- [x] Run targeted and full tests.

### Task 2: Durable attachment egress

**Files:** packages/core/src/store/outbox.ts, packages/core/src/store/tasks.ts, packages/core/src/store/schema.ts, packages/core/src/runtime.ts, packages/core/src/artifacts.ts; test/media-delivery.test.ts.

**Interfaces:** Outbox entries retain ordered text parts plus task artifact references. Runtime resolves those references only through the task's indexed output directory, snapshots bytes safely and rechecks access immediately before sending. Per-part receipts atomically update task delivery and remove acknowledged files.

- [x] Write failing tests for text+media retry, file-only retry, restart, private snapshots, authorization loss and unconfirmed receipts.
- [x] Commit the complete task delivery plan before the first platform send, atomically clearing host recovery ownership.
- [x] Retry only remaining parts; preserve manual `/resend` as direct access to the indexed originals.
- [x] Run targeted and full tests.

### Task 3: One-time state migration

**Files:** packages/core/src/store/state.ts, schema.ts, layout.ts, inventory.ts, bin/doctor.mjs and state fixtures/tests.

**Interfaces:** StateFile migrates legacy or version1 canonical state once into version2. All required sections are collected before committing; existing canonical sections win. Originals move to a declared private backup directory after the commit. Doctor reads canonical state and reports schema problems; explicit `--migrate` uses the same migration implementation.

- [x] Add failing tests for complete import, bad input, persistence/backup failure, restart after commit, backup collisions and stale mirrors.
- [x] Remove runtime dual writes and mtime-based imports. Update existing tests to inspect and mutate canonical state rather than mirror files.
- [x] Update operator docs, run full tests and package checks, and review changes independently.

## Live evidence

The mini session's turn22 generated `output/aircraft-bombing-warship.png` (4,183,902 bytes), then used `read_image` and returned Markdown. It emitted no `deliverables/presented`; task50eaf959 had no artifact index and incorrectly reported delivery sent. The image was recovered read-only to the local visualization workspace. The following turn acknowledged that a Markdown path does not upload a file. Existing desktop guidance prefers inline references, which needs a channel-specific override on channel inputs.

## Execution record

- Completed in the existing dirty codex branch; prior changes preserved, no git commit/push.
- 421-test baseline; final 447-test suite passes. Package dry-runs and git diff whitespace checks pass. All packaged dist files match the verified workspace byte-for-byte.
- Added explicit per-input delivery guidance and conservative standalone image declarations. Rejected images mark incomplete delivery. Examples, quotes, HTML and escaped image syntax are ignored.
- Text and hashed task artifact references now share one outbox envelope, serial writer and atomic task receipts. Restarts retain the original inbound context; retries snapshot and recheck current access/config, reject changed bytes and reuse the original captured index.
- One-time v2 migration validates all sections, commits before archival, preserves original bytes/colliding backups and resumes interrupted archive. Doctor is read-only unless --migrate is explicit. Existing fixtures now inspect canonical bytes.
- Independent review exposed whitespace queue corruption and code-example declarations; added failing regressions and fixed both. Added revocation-during-snapshot and failed-handoff/changed-source recovery regressions.
- Deployed verified core/Weixin artifacts to mini under 20261119-media-fvb3YI with profile/state backup and rollback-before-activation support. Installed 131 core and93 Weixin dist/bin files match archives; service and polling restarted, configuration unchanged.
- Installed-package smoke test used the recovered original PNG with an isolated fake adapter, including failed upload/retry and no repeated text/tools. Original live task received a manual retrieval index only; no real-account test message or model generation was sent.
- Real phone acceptance uses /resend 50eaf959 in the originating chat. Telegram archive uploaded but not enabled. Details and checksums are in docs/STATUS.md.
