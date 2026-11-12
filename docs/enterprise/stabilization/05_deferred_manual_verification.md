# GCAC Stabilization — Deferred & Manual Verification Checklist

## 1. Purpose

Automated JavaScript (`14/14` suites) and .NET (`66/66` tests) suites verified core logic, security boundaries, caching, retry guards, state contracts, and mock/fixture integrations. The items below were **not** executed live in this headless CLI environment (no active VS Code GUI window, no live GitHub Copilot Chat LLM session, and no active Linux Docker/Podman daemon) and must be completed before production release sign-off.

## 2. Live Container & Toolchain Verification (`G3-06` & Sandboxed Adapters)

| ID | Verification Check | Precondition | Expected Outcome |
| :---: | :--- | :--- | :--- |
| **M-01** | Live Container Smoke (`G3-06`) & `dotnet-security` / `nuget-audit` Execution | Start Linux Docker daemon or Podman v4+ and run Phase 3 test suite on a container-enabled host. | `G3-06` executes inside isolated container without skipping (`SANDBOX_UNAVAILABLE` cleared); container mounts stay read-only/scoped per policy and exit cleanly. |
| **M-02** | `SANDBOX_UNAVAILABLE` Live Recovery via `Retry Stage` | Attempt remediation run while Docker daemon is stopped; start Docker daemon; click `Retry Stage` in Webview. | Initial run fails closed with `SANDBOX_UNAVAILABLE`; clicking `Retry Stage` triggers `discoverEnvironment({ forceRefresh: true })`, clears block automatically, and resumes stage execution. |
| **M-03** | Optional CodeQL Comprehensive Scan | Install supported `codeql` CLI + C#/Java/JS query packs and run `Comprehensive Scan` on a sample repository. | CodeQL adapter executes bounded async scan, honors `Cancel Scan` if aborted (`activeProcess` killed), and reports findings alongside coverage metadata. |

## 3. VS Code Extension Development Host & Webview GUI Checks

| ID | Verification Check | Steps | Expected Outcome |
| :---: | :--- | :--- | :--- |
| **M-04** | Simulated `Execute` Removal Check | Press `F5` to open Extension Development Host and inspect GCAC Dashboard header & detail pane. | Neither `#btnHeaderQuickRun` nor `#btnRunRemediation` (`Execute Engine`) exists anywhere in the UI; only supported Copilot handoff, scan, retry, sync, and gate controls render cleanly. |
| **M-05** | Quick Scan vs Comprehensive Scan Progress UI | Trigger `Quick Scan` then `Comprehensive Scan` on `sample-repos` or external repo. | `.scan-progress-indeterminate` animates cleanly when totals are unknown without fake percentages; Quick Scan renders explicit coverage warning banner listing omitted heavyweight scanners; second unchanged scan displays explicit `CACHED_SOURCE_HASH_VERIFIED` indicator. |
| **M-06** | `Cancel Scan` Interactive Termination | Start a `Comprehensive Scan` on a large repository and click Cancel mid-scan. | Running child scan process terminates promptly, UI resets cleanly to cancelled/incomplete state without partial corrupt state, and zero orphan OS processes remain. |
| **M-07** | Preview Server Guard Verification | Start `node scripts/preview-dashboard.js` without `GCAC_ALLOW_DEV_PREVIEW_SIMULATION=1` and test `POST`/`GET` `/api/remediate-stream`. | Server returns `HTTP 403` and Webview displays read-only review controls without invoking simulated remediation streams. |

## 4. Live GitHub Copilot Chat (`@vulnerability-orchestrator`) & `SCAN-SECRET-005` Flows

| ID | Verification Check | Steps | Expected Outcome |
| :---: | :--- | :--- | :--- |
| **M-08** | Handoff Banner & `Sync Status` Button | Click `Run with Copilot` / `launchCopilot` for a queued finding in VS Code Extension Host. | Webview displays `#copilotHandoffBanner` (`HANDED_OFF_TO_COPILOT` / `AWAITING_VERIFIED_RESULT`), does **not** hang claiming `Stage 6 Running`, and `#btnSyncRunState` reconciles latest disk run-state/artifacts on click. |
| **M-09** | `@vulnerability-orchestrator` Chat Formatting & Broadcast | Invoke `@vulnerability-orchestrator` in live Copilot Chat workspace session. | Chat response uses strict enterprise structure (`Workflow Status`, `Validation Outcome`, `Final Review Status`, `Evidence Completeness`) with zero decorative emojis, and open Webview receives synchronized stage updates live. |
| **M-10** | Live `SCAN-SECRET-005` (`ReceiptController.cs`) End-to-End Check | Inspect/run `SCAN-SECRET-005` in `sample-repos/payments-api` where build/test exits with `CS1069` (`Exit Code: 1`, `Passed: 0`, `Failed: 0`), then remediate & re-verify. | Initial failed run renders `Stage 6: FAILED`, Stage 8 `BLOCKED`, terminal banner `Workflow Ended — Validation Failed`, zero `40/100` scores, and mandatory credential rotation/revocation controls; Retry button stays unlocked; after genuine fix, deterministic `GCAC-EVIDENCE-CHECKLIST-1.0` allows Stage 8 review only once validation & required checks pass. |

