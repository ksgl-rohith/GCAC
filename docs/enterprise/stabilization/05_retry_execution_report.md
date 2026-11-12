# GCAC Retry Stage Root-Cause & Reliability Report

**Report ID**: `05_retry_execution_report`  
**Files Changed**: [`remediationEngine.js`](../../../extension/remediationEngine.js), [`extension.js`](../../../extension/extension.js), [`dashboard.js`](../../../extension/media/dashboard.js), [`dashboard.html`](../../../extension/media/dashboard.html), [`preview-dashboard.js`](../../../scripts/preview-dashboard.js)

---

## 1. Root Causes of "Retry Stage Button Does Not Work"

Code tracing identified six distinct failure points causing Retry Stage to lock up or silently fail:

1. **Permanent UI Lockout (`isRemediating = true`)**: Clicking `#btnRetryStage` in [`dashboard.js`](../../../extension/media/dashboard.js) immediately set `isRemediating = true` and disabled `#btnRetryStage` and `#btnReviseFix`. When [`extension.js`](../../../extension/extension.js) rejected an ineligible retry (or untrusted workspace) and returned early, it sent `DETAILS_LOADED` without a `RETRY_UNAVAILABLE` signal, and `DETAILS_LOADED` did not reset `isRemediating`. Both buttons stayed permanently disabled until Webview reopen.
2. **Stale `status: 'APPROVED'` in `run-state.json`**: When post-fix tests failed without throwing an exception, `run-state.json` retained Stage 4's `status: 'APPROVED'` on disk, confusing downstream retry and reload classification.
3. **Missing Isolated Worktree Not Caught Before Retry**: Retrying from Stage 5+ when `isolatedWorkspace.worktreeDir` had been removed/pruned failed deep inside Stage 5 with `POST_APPLY_DRIFT` rather than evaluating worktree presence upfront in `evaluateRetryEligibility`.
4. **No Empty Approved File Manifest Check**: Stage 6+ retries checked diff hashes and approval expiry, but did not reject empty `approvedFilePaths`.
5. **No Live Environment Recovery Re-Check**: When a prior run failed with `SANDBOX_UNAVAILABLE`, retry eligibility relied strictly on manual `environmentRecovered: true` flags instead of re-probing `discoverEnvironment({ forceRefresh: true })`.
6. **Preview Server Misrouting**: In [`preview-dashboard.js`](../../../scripts/preview-dashboard.js), `retryStage` and `reviseFix` posted to `/api/approve`, producing an unrelated approval error instead of an explicit read-only diagnostic message.

---

## 2. Retry Verification & Recovery Architecture Implemented

### Pre-Retry 12-Point Gatekeeper (`evaluateRetryEligibility` & `retryStage`)

1. Validates single clean Vulnerability ID (`SEC-02`) and Workspace Trust (`workspaceTrusted !== false`).
2. Enforces single-run concurrency lock (`this.activeRuns`).
3. Validates repository/application context (`validateFindingContextContract`).
4. Verifies `runId` match when `expectedRunId` is supplied.
5. Blocks retry of formally resolved runs (`ALREADY_COMPLETED` / Stage 9 `RESOLVED_CLOSED`).
6. Enforces transient-failure eligibility: only `TIMED_OUT`, `CANCELLED`, `RUNNER_CRASH`, `INTERRUPTED_BY_RELOAD`, `SCAN_FAILED_TRANSIENT`, or recovered environment issues (`SANDBOX_UNAVAILABLE` / `TEST_TOOL_MISSING`) allow blind `Retry Stage`.
7. Blocks blind retry for genuine code/test/build/security failures (`TESTS_FAILED`, `BUILD_FAILED`, `NO_TESTS_DISCOVERED`, `STILL_PRESENT`, `REGRESSION_DETECTED`), directing operators to **Review Failure / Revise Fix** (`canReviseFix: true`).
8. Verifies isolated worktree directory exists on disk (`WORKTREE_MISSING` -> requires `Revise Fix`).
9. Verifies Stage 4 approval presence, `APPROVED` decision, and non-expiration (`APPROVAL_EXPIRED`).
10. Recomputes and verifies proposed diff SHA-256 (`DIFF_CHANGED`) and non-empty `approvedFilePaths` (`EMPTY_APPROVED_FILE_MANIFEST`).
11. Verifies live post-apply file SHA-256 checksum matches `expectedPostApplySha256` (`SCOPE_OR_FILE_MODIFIED`).
12. Enforces bounded `maxRetries`, exponential backoff, archives prior attempt artifacts under `remediation-output/<ID>/attempts/<attemptId>/`, resets canonical stages `>= resolvedStage` cleanly, and emits `RETRY_STARTED` / `RETRY_REJECTED`.

### UI / IPC Synchronization Guarantees

- Initial preload (`getPreloadedDetails`) and `loadDetails` always compute and include `retryEligibility`.
- Rejection at Host IPC (`retryStage`) emits `RETRY_UNAVAILABLE`, resets `isRemediating = false` in `dashboard.js`, re-renders current details cleanly, and displays exact reason (`Retry Stage (Transient)` vs `Review Failure / Revise Fix`).
- Verified by unit + negative security tests in `realWorldUsability.test.js` Block E and [`productionStabilization.test.js`](../../../tests/extension/productionStabilization.test.js).

