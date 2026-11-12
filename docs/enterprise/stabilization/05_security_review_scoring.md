# GCAC Security Review, Evidence Checklist & Sign-Off Governance Report

**Report ID**: `05_security_review_scoring`  
**Contract Version**: `GCAC-EVIDENCE-CHECKLIST-1.0`

---

## 1. Investigation of "Confidence Score: 40/100"

Auditing [`remediationEngine.js`](../../../extension/remediationEngine.js), [`reportParser.js`](../../../extension/reportParser.js), [`extension.js`](../../../extension/extension.js), and [`dashboard.js`](../../../extension/media/dashboard.js) located the exact origin of `Confidence Score: 40/100`:

1. [`remediationEngine.js`](../../../extension/remediationEngine.js) previously asked the LLM for `"score": <number 0-100>`, then clamped failed validations with:
   `securityReview.score = Math.min(Number(securityReview.score || 40), 40);`
   When an independent review fallback or LLM response omitted or scored validation failures, it deterministically output `40/100` (or `50/100` for non-`FAILED` incomplete states).
2. [`reportParser.js`](../../../extension/reportParser.js) re-clamped parsed scores to `Math.min(score, 40)` on failed reports.
3. [`dashboard.js`](../../../extension/media/dashboard.js) displayed `"Autonomous Validation Confidence Score: <score> / 100"` as the primary validation quality bar.
4. Worse still, when validation failed (`SCAN-SECRET-005`, `CS1069`, exit code 1), `remediationEngine.js` returned `isAwaitingFinalApproval: true` and Copilot displayed both `Confidence Score: 40/100` and `@vulnerability-orchestrator /final-approve SCAN-SECRET-005`.

---

## 2. Replacement: Deterministic Evidence Verification Checklist ([`evidenceChecklist.js`](../../../extension/evidenceChecklist.js))

Opaque `/100` confidence scores were removed from the LLM audit prompt, security review rating logic, markdown reports, Copilot Chat output, and the Webview Validation Evidence tab. Instead, GCAC evaluates an explicit, verifiable checklist using statuses `PASS`, `FAIL`, `MISSING`, and `NOT_APPLICABLE`:

### Core Applicable Checks (Non-Secret Findings)

1. `ROOT_CAUSE_ANALYSIS` — Structured RCA documented
2. `SOURCE_TO_SINK_EVIDENCE` — Source-to-sink trace or location evidence (`NOT_APPLICABLE` if secret finding)
3. `BASELINE_EVIDENCE` — Baseline execution result or documented reason baseline could not run
4. `CODE_DIFF_INTEGRITY` — Proposed diff SHA-256 matches Stage 4 approval & Stage 5 post-apply scope check
5. `POST_FIX_TEST_EXECUTION` — Genuine build + test execution (`executed === true`, `exitCode === 0`, `testsTotal > 0`, `testsFailed === 0`)
6. `SCANNER_RESCAN` — Originating scanner re-scan (`NOT_APPLICABLE` only when finding has no scanner provenance)
7. `INDEPENDENT_SECURITY_CHECKS` — Suppression directives, test weakening, tampering, and prompt-injection checks clean

### Additional Checks Automatically Enabled for Secret/Credential Findings

Triggered deterministically when `Rule_ID`, `CWE` (`CWE-798`, `CWE-321`, `CWE-259`, `CWE-522`), ID (`SCAN-SECRET-*`), or title matches credential exposure:

8. `SECRET_MANAGER_REPLACEMENT` — Code diff externalizes secret to env/secret store (`IConfiguration`, `Environment.GetEnvironmentVariable`, `SecretClient`, `KeyVault`, `process.env`, etc.)
9. `SECRET_REVOCATION_CONFIRMED` — Operator recorded credential revocation at provider (`MISSING` unless explicitly confirmed)
10. `SECRET_ROTATION_CONFIRMED` — Operator recorded rotated replacement secret provisioning (`MISSING` unless explicitly confirmed)
11. `EXPOSED_CREDENTIAL_INVALIDATED` — Operator confirmed exposed value in Git history/logs cannot be replayed (`MISSING` unless explicitly confirmed)

---

## 3. Transparent Completeness & Gate Outcomes

- **Transparent Ratio**: `NOT_APPLICABLE` checks are excluded from the denominator so reports display exact verified fractions (e.g., `6 of 6 required checks complete` for non-secret fixes, or `7 of 10 required checks complete` when a secret code fix passed tests/re-scan while 3 manual rotation/revocation confirmations remain pending).
- **Deterministic Reviewer Dispositions**:
  - `BLOCKED` (`Final Review Status: BLOCKED — Post-fix validation failed`): Whenever `failedCount > 0`, post-fix tests fail/zero tests run/`BUILD_FAILED`, scanner re-scan reports `STILL_PRESENT`/`REGRESSION_DETECTED`, suppression directives appear, or integrity verification detects tampering. **Stage 8 Final Sign-Off is strictly prohibited (`finalGateBlocked: true`, `isAwaitingFinalApproval: false`).**
  - `REVIEW_REQUIRED`: All executed checks passed, but required manual/verification items remain `MISSING` (including secret revocation/rotation actions on `CWE-798` / `SEC-001` findings).
  - `READY_FOR_REVIEW`: Every applicable check passed (`passedCount === totalApplicable && failedCount === 0 && missingCount === 0`).

