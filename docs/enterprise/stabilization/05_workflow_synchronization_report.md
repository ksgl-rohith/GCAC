# GCAC Workflow & Copilot–Webview Synchronization Report

**Report ID**: `05_workflow_synchronization_report`  
**Schema Version**: `GCAC-RUN-STATE-2.0` / `GCAC-RUN-EVENT-2.0`

---

## 1. Root Causes Discovered by Tracing Both Paths

Investigation of `SCAN-SECRET-005` (`ReceiptController.cs` inside `sample-repos/payments-api`) traced the exact desynchronization between Copilot Chat and the GCAC Webview Dashboard to five architectural defects:

1. **Mismatched 7-Stage vs 9-Stage Models**:
   - [`RemediationEngine`](../../../extension/remediationEngine.js) emitted 9 stages where `Stage 5 = remediation`, `Stage 6 = bench-test`, `Stage 8 = final-human-gate`, and `Stage 9 = manual-validations`, while [`reportParser.js`](../../../extension/reportParser.js) initialized 7 stages where `Stage 5 = bench-test` (index 4) and `Stage 6 = final-human-gate` (index 5).
   - [`dashboard.js`](../../../extension/media/dashboard.js) mapped events via `evt.stageNumber - 1`, placing Engine `Stage 6 (bench-test)` into UI index `5` (`Stage 6: Final Human Approval Gate`).
2. **Stage 6 Failures Emitted `STAGE_COMPLETE`**:
   - At [`remediationEngine.js`](../../../extension/remediationEngine.js) Stage 6 (`bench-test`), even when `postFixValidation.passed === false` or `reScanVerification.stillPresent === true`, the engine emitted `type: 'STAGE_COMPLETE'` rather than `STAGE_FAILED`, leaving UI steppers inconsistent or stalled.
3. **Copilot Chat Participant Did Not Broadcast Progress or Terminal State to Webviews**:
   - `@vulnerability-orchestrator` in [`extension.js`](../../../extension/extension.js) wrote progress markdown directly to `response.markdown(...)` without calling `broadcast({ type: 'REMEDIATION_PROGRESS' })`, `DATA_UPDATED`, or `DETAILS_LOADED` to open Webview panels.
4. **Stage 8 Final Sign-Off Offered After Validation Failure**:
   - When `isFinalApproved === false`, `executePipeline` unconditionally returned `isAwaitingFinalApproval: true` and emitted `FINAL_GATE_REQUIRED`, even when `outcomeEvaluation.isResolved === false`. `@vulnerability-orchestrator` then printed Stage 9 concluded/failed while presenting `@vulnerability-orchestrator /final-approve SCAN-SECRET-005`.
5. **Unobserved Native Copilot Prompt Launch State**:
   - Clicking `Run with Copilot` (`launchCopilot`) opened VS Code Chat without recording any persisted handoff state, and Webviews could not tell whether Copilot was idle, waiting, or completed elsewhere.

### Root Cause of `SCAN-SECRET-005` (`Passed: 0, Failed: 0, Exit Code: 1`)

Executing `dotnet test -v normal` inside `sample-repos/payments-api` fails compilation before any test executes because sibling file `PaymentController.cs` contains `using System.Data.SqlClient;` without a matching NuGet `PackageReference` in `PaymentsAPI.csproj` (`error CS1069`, `Build FAILED`, exit code `1`). [`testRunner.js`](../../../extension/testRunner.js) accurately classifies this as `BUILD_FAILED` with `countsKnown: false` (meaning compilation failed prior to test discovery/execution, NOT that 0 vulnerable scenarios exist).

---

## 2. Canonical Run-State & Event Contract Implemented

Implemented [`runStateContract.js`](../../../extension/runStateContract.js) (`RunStateManager`), unifying all producers and consumers on **Canonical 9 Stages**:

| Stage # | Canonical `stageId` | Stage Label | Role |
| ---: | --- | --- | --- |
| 1 | `intake` | Intake & Mapping | Validate single finding, canonical repo ID, worktree isolation |
| 2 | `classification` | Classification | Advisory AI triage + immutable scanner severity (SEC-09) |
| 3 | `analysis` | Source Analysis & Baseline | RCA, source-to-sink evidence, baseline test, patch proposal |
| 4 | `human-gate` | Human Approval Gate | Mandatory stop; diff SHA-256 bound human authorization |
| 5 | `remediation` | Code Remediation | Apply approved patch strictly inside isolated worktree |
| 6 | `bench-test` | Bench Test & Re-Scan | Real build/test execution + originating scanner re-scan |
| 7 | `security-review` | Security Review & Evidence | Deterministic evidence checklist & regression evaluation |
| 8 | `final-human-gate` | Final Sign-Off | Human sign-off gate (automatically `BLOCKED` on validation failure) |
| 9 | `manual-validations` | Workflow Closure | Immutable evidence manifest & terminal conclusion state |

### Separated Five Lifecycle Planes (`GCAC-RUN-STATE-2.0`)

1. `workflowLifecycle`: `NOT_STARTED | HANDED_OFF_TO_COPILOT | AWAITING_VERIFIED_RESULT | IN_PROGRESS | WAITING_APPROVAL | COMPLETED | CANCELLED | ERROR`
2. `stageExecutionLifecycle`: 9-stage array tracking `pending | active | awaiting_review | completed | failed | blocked`
3. `securityValidationOutcome`: `NOT_EXECUTED | PASSED | FAILED | COULD_NOT_RUN | REGRESSION_DETECTED | NOT_VERIFIED | BLOCKED`
4. `approvalDecision`: `NOT_REQUESTED | PENDING_STAGE4 | APPROVED_STAGE4 | REJECTED_STAGE4 | PENDING_STAGE8 | APPROVED_STAGE8 | BLOCKED_STAGE8 | REJECTED_STAGE8`
5. `formalClosure`: `OPEN | HANDED_OFF_TO_COPILOT | IN_REMEDIATION | VALIDATION_FAILED | COULD_NOT_RUN | AWAITING_FINAL_SIGN_OFF | RESOLVED_CLOSED | ROLLED_BACK`

Each event (`GCAC-RUN-EVENT-2.0`) includes `runId`, `findingId`, `repositoryId`, `stageId`, `stageNumber`, `attemptId`, `attemptNumber`, `seq`, `timestamp`, `eventType`, `executionState`, `validationOutcome`, `evidenceRef`, and `origin`.

---

## 3. Copilot Boundary & Event Ordering Guarantees

- **Honest Copilot Handoff**: `launchCopilot` in [`extension.js`](../../../extension/extension.js) calls `RunStateManager.recordCopilotHandoff()`, setting `workflowLifecycle: HANDED_OFF_TO_COPILOT` and `findingState: AWAITING_VERIFIED_RESULT`. Stage 6 is never marked running merely because Copilot Chat opened. An explicit **`Sync Status`** (`#btnSyncRunState` -> `syncRunState`) control refreshes persisted canonical state on demand.
- **Broadcast Synchronization**: `@vulnerability-orchestrator` broadcasts every `STAGE_START`, `STAGE_COMPLETE`, `STAGE_FAILED`, `FINAL_GATE_BLOCKED`, and post-run `DATA_UPDATED` / `DETAILS_LOADED` payload directly to all active Webview panels.
- **Replay & Ordering Defense**: `RunStateManager.applyEvent()` and Webview `handleRemediationProgress()` reject events with mismatched `runId`, lower `attemptNumber`, duplicate `eventId`, or non-monotonic `seq`.
- **Failed Validation Terminal State**: Stage 6 failure emits `STAGE_FAILED`, Stage 8 emits `FINAL_GATE_BLOCKED`, and Stage 9 concludes cleanly with `terminalBanner: "Workflow Ended — Validation Failed"`, `findingState: "VALIDATION_FAILED"`, `isAwaitingFinalApproval: false`, and `finalGateBlocked: true`.

