# Channel project and session routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan inline.

**Goal:** Select configured projects and return to this chat's own session lines from channel commands.
**Architecture:** Extend the existing atomic session-line store; snapshot the selected workspace and session into each inbox entry. Pass that workspace to the turn driver and retain it with task artifacts.
**Tech Stack:** TypeScript, Node test runner, existing JSON state stores.
**Spec:** User-approved channel capabilities roadmap, step 2 (project/session switching).

## Global Constraints

Preserve legacy default session IDs and counter migration. Only configured absolute project paths are accepted. Commands never enumerate host sessions or accept raw paths/IDs. Group sessions remain shared among authorized group members, as with /new. Switching affects future input only. Removed or changed project routes block queued work rather than silently retargeting it. Historical artifacts must use a currently configured workspace. Corrupt routing state fails closed. Work on codex/channel-session-routing in place; preserve .DS_Store. No deployment or real chat messages during verification.

## Review Focus

Route persistence failures, high-water session allocation after returning to old lines, queue/restart isolation, project path changes, and historical file containment.

### Task 1: Project and session selection

- [x] Write failing routing integration tests and observe failures.
- [x] Add projects config and extend atomic session state with selection and per-project high-water lines.
- [x] Add /projects, /project <alias>, /sessions, /session <number>; keep /new compatible.
- [x] Snapshot route into inbox and tasks; use it for agent cwd/output and artifact retrieval.
- [x] Verify focused tests and full suite.

### Task 2: Documentation and final review

- [x] Document commands, configuration, group sharing, migration and removed-project recovery.
- [x] Run a fresh whole-change review; fix actionable findings.
- [x] Run final build/tests and report the result.
