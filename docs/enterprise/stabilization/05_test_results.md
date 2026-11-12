# GCAC Stabilization — Automated Test & Verification Results

## 1. Execution Environment

- **Host Architecture**: `darwin/arm64`
- **Node.js Runtime**: `v20.20.0`
- **.NET Host / Roll-Forward**: `.NET 10 SDK` executing `net9.0` targets via `DOTNET_ROLL_FORWARD=Major`
- **Container Runtime Status**: No active Linux Docker daemon or Podman v4+ engine available on host (`SANDBOX_UNAVAILABLE`)

## 2. JavaScript Automated Test Suites (`npm test`)

Command executed after final code modifications:

```bash
npm test
```

### Observed Outcome

- **Total Suites**: `14`
- **Passed Suites**: `14`
- **Failed Suites**: `0`
- **Total Duration**: `11.03s`

### Registered Suite Breakdown (`tests/extension/run-all-tests.js`)

| # | Suite Name | Status | Scope / Notes |
| :---: | :--- | :---: | :--- |
| 1 | `CSV Parser & Row Isolation` | Passed | Raw CSV intake isolation & field validation |
| 2 | `Report Parser & Evidence Discovery` | Passed | 9-stage report parsing & evidence hydration |
| 3 | `Security Containment & Webview Hardening` | Passed | IPC allowlist (`launchCopilot` allowed, `runRemediation` rejected) & CSP hardening |
| 4 | `Deterministic Test Runner Execution` | Passed | Exit-code and test summary extraction fidelity |
| 5 | `Workflow State Machine & Approval Gates` | Passed | State transitions, approval requirements & gate enforcement |
| 6 | `Dashboard Metrics & Quality Accuracy` | Passed | Honest dashboard aggregation without inflation |
| 7 | `Scanner Adapters & Controller Execution` | Passed | Adapter discovery, `ScanController` fixture completed in `41ms` |
| 8 | `Normalized Findings Model & Storage` | Passed | `FindingModel` schema & `FindingsStore` persistence |
| 9 | `Post-Remediation Re-Scanning & Verification` | Passed | `ReScanVerifier` clean verification & emoji-free reporting |
| 10 | `Phase 1 P0 Security Containment & Core Integrity` | Passed | P0 path containment & instruction integrity |
| 11 | `Phase 2 Trust Controls & Secure Remediation Governance` | Passed | Tamper detection, prompt-injection screening (`INJ-*`), Stage 8 blocking |
| 12 | `Phase 3 Execution Isolation, Approved Toolchains & Supply Chain Security` | Passed | Isolation, approved toolchains, hash checks (`G3-06 live container smoke` skipped cleanly: `SANDBOX_UNAVAILABLE (darwin/arm64)`) |
| 13 | `Real-World Usability, Scan Accuracy, Portability & Retry` | Passed | Legacy compat, repository registration, scanner portability & retry behavior |
| 14 | `Production Workflow Stabilization & Reliability` | Passed | Workstreams A–F, `ScanCache`, `RunStateManager`, `SCAN-SECRET-005` (`CS1069`), retry eligibility, checklist & preview `403` guard |

## 3. .NET Build & Automated Test Suite

Command executed after final code modifications:

```bash
dotnet build && DOTNET_ROLL_FORWARD=Major dotnet test --no-build
```

### Observed Outcome

- **Build**: `Build succeeded. 0 Warning(s), 0 Error(s)` (`Time Elapsed 00:00:02.39`)
- **Test Execution**: `Passed! - Failed: 0, Passed: 66, Skipped: 0, Total: 66, Duration: 20 s`

## 4. Suite 14 (`productionStabilization.test.js`) Coverage Mapping

- **Workstream A (Scanner Performance, Caching & Modes)**:
  - Empty repository clean completion with zero spurious errors.
  - `ScanCache` deterministic cache hit on unchanged files (`fromCache: true`, `CACHED_SOURCE_HASH_VERIFIED`), invalidation upon source mutation, cross-repository isolation, and advisory TTL expiry for `nuget-audit`.
  - Quick vs Comprehensive scan mode differences and explicit `omittedScanners` disclosure.
  - Real `AbortController` cancellation terminating owned adapter subprocesses, missing tool availability reporting (`unavailable`), and command timeout incomplete reporting.
- **Workstream B (Canonical Run State & Sync)**:
  - `SCAN-SECRET-005` (`ReceiptController.cs`, `CS1069` build failure, `Exit Code: 1`, `Passed: 0`, `Failed: 0`) correctly transitions Stage 6 to terminal `FAILED`, blocks Stage 8 final gate (`finalGateBlocked: true`), sets finding state to `VALIDATION_FAILED`, and surfaces `Workflow Ended — Validation Failed`.
  - `RunStateManager` drops events with mismatched `runId`, lower `attemptNumber`, duplicate `eventId`, or out-of-order `seq`.
  - Copilot handoff emits `HANDED_OFF_TO_COPILOT` / `AWAITING_VERIFIED_RESULT` without fabricating Stage 6 completion until real evidence arrives.
- **Workstream C (Retry Eligibility & Recovery)**:
  - Negative security/state guards block retry cleanly with machine-readable codes (`WORKTREE_MISSING`, `EMPTY_APPROVED_FILE_MANIFEST`, `APPROVAL_EXPIRED`, `DIFF_CHANGED`, `SCOPE_OR_FILE_MODIFIED`, `ALREADY_COMPLETED`).
  - `SANDBOX_UNAVAILABLE` triggers `discoverEnvironment({ forceRefresh: true })` re-evaluation upon retry and clears UI lockout on rejection (`RETRY_UNAVAILABLE`).
- **Workstream D (Removal of Simulated Execute)**:
  - `extension.js` IPC validator rejects `'runRemediation'`.
  - `scripts/preview-dashboard.js` denies `/api/remediate-stream` with `HTTP 403` unless `GCAC_ALLOW_DEV_PREVIEW_SIMULATION === '1'`.
- **Workstream E (Deterministic Evidence Checklist & Secret Controls)**:
  - Zero `40/100` or subjective score strings emitted in checklist artifacts or engine state.
  - `GCAC-EVIDENCE-CHECKLIST-1.0` excludes `NOT_APPLICABLE` checks from numerator/denominator, reflects failed validation as `BLOCKED`, and mandates 4 secret-remediation controls for credential findings.
- **Workstream F (Enterprise Copilot Formatting)**:
  - `copilotOutputFormatter.js` and `ReScanVerifier` markdown outputs contain zero decorative emojis while cleanly rendering separated lifecycle states.

## 5. Scanner Performance Benchmark Comparison (Monotonic Timers)

Recorded on `darwin/arm64` (`Node.js v20.20.0`) comparing pre-optimization baseline against post-stabilization implementation:

| Benchmark Workload | Before (`ms`) | After Cold (`ms`) | After Cached (`ms`) | Notes |
| :--- | :---: | :---: | :---: | :--- |
| `getAvailableScanners` (3 calls across repos) | `7988.03` | `123.89` | — | Eliminated redundant `which` subprocess spawns |
| `payments-api` (30 files, 9 eligible) | `2217.15` | `46.66` | `29.85` | Quick Scan measured at `36.16 ms` |
| `sample-repos` (83 files) | `2148.95` | `167.00` | `31.59` | Full controller scan |
| `synthetic-600` (1002 total: 601 src + 401 deps/bin) | `1266.83` | `228.77` | `69.26` | Quick Scan measured at `72.51 ms` |
| `synthetic-600` `discoverProjectManifests` | `89.29` | `20.73` | — | Bounded non-`.csproj` reads to `512` bytes |
| `synthetic-600` `SecretsConfigScanner` | `73.09` | `47.37` | — | Bounded concurrency (`16`) + per-dir canonical check |
| `FindingsStore` (40 sequential reads) | `3.53` | — | `0.86` | `mtimeMs` + `size` read cache |

