'use strict';

const { CANONICAL_STAGES } = require('./runStateContract');
const { COPILOT_APPROVAL_LIMITATION_DISCLOSURE } = require('./approvalGovernance');

const EMOJI_AND_DECORATIVE_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F]/gu;

function stripDecorativeSymbols(text = '') {
    return String(text ?? '')
        .replace(EMOJI_AND_DECORATIVE_REGEX, '')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

function getStageDisplayName(stageNumber, stageId) {
    const found = CANONICAL_STAGES.find(
        s => s.stageNumber === Number(stageNumber) || (stageId && s.id === stageId)
    );
    return found ? `Stage ${found.stageNumber} (${found.label})` : `Stage ${stageNumber || '?'} (${stageId || 'context'})`;
}

function formatHelpMarkdown() {
    return [
        '### GCAC Vulnerability Orchestrator',
        '',
        'Enterprise vulnerability remediation workflow controller.',
        '',
        '**Available Commands:**',
        '- `@vulnerability-orchestrator /remediate-vulnerability <ID>` — Execute Stage 1 through Stage 3 and pause at Stage 4 Human Approval Gate.',
        '- `@vulnerability-orchestrator /approve <ID>` — Authorize Stage 4 diff-bound patch, apply inside isolated worktree (Stage 5), and run Stage 6/7 verification.',
        '- `@vulnerability-orchestrator /final-approve <ID>` — Record final Stage 8 sign-off and conclude Stage 9 evidence closure (prohibited if validation failed).',
        '',
        '**Usage Example:**',
        '- `@vulnerability-orchestrator /remediate-vulnerability SCAN-SECRET-005`',
        ''
    ].join('\n');
}

function formatRunHeaderMarkdown(vulnId, runModeDesc) {
    return [
        `### GCAC Orchestrator: \`${stripDecorativeSymbols(vulnId)}\``,
        `- **Requested Operation**: ${stripDecorativeSymbols(runModeDesc)}`,
        ''
    ].join('\n') + '\n';
}

function formatStageEventMarkdown(evt) {
    if (!evt || typeof evt !== 'object') return '';
    const stageLabel = getStageDisplayName(evt.stageNumber, evt.stageId);
    const summary = evt.summary ? stripDecorativeSymbols(evt.summary) : '';

    if (evt.type === 'STAGE_START') {
        return `- **${stageLabel}** — ACTIVE\n`;
    }
    if (evt.type === 'STAGE_COMPLETE') {
        return `- **${stageLabel}** — COMPLETED${summary ? `: ${summary}` : ''}\n`;
    }
    if (evt.type === 'STAGE_FAILED') {
        const cat = evt.failureCategory ? ` [${evt.failureCategory}]` : '';
        return `- **${stageLabel}** — FAILED${cat}${summary ? `: ${summary}` : ''}\n`;
    }
    if (evt.type === 'STAGE_BLOCKED' || evt.type === 'FINAL_GATE_BLOCKED') {
        return `- **${stageLabel}** — BLOCKED${summary ? `: ${summary}` : ''}\n`;
    }
    return '';
}

function formatGateMarkdown(vulnId, result) {
    if (result.isAwaitingApproval) {
        const lines = [
            '',
            '---',
            '### Gate 4 — Human Approval Required',
            `- **Finding ID**: \`${vulnId}\``,
            '- **Workflow Status**: `AWAITING APPROVAL`',
            `- **Baseline Validation**: \`${stripDecorativeSymbols(result.baselineValidation ? result.baselineValidation.status : 'NOT EXECUTED')}\``,
            result.proposedDiffSha256 ? `- **Proposed Diff SHA-256**: \`${result.proposedDiffSha256}\`` : null,
            '- **Identity Status**: `AUTHENTICATION_NOT_VERIFIED` (Local IDE Mode)',
            `- **Control Boundary**: ${stripDecorativeSymbols(COPILOT_APPROVAL_LIMITATION_DISCLOSURE)}`,
            '',
            '**Proposed Diff:**',
            '```diff',
            String(result.patchDiff || '').trim(),
            '```',
            '',
            '**Required Action:**',
            `- Authorize in Copilot Chat: \`@vulnerability-orchestrator /approve ${vulnId}\``,
            '- Or review and authorize via Stage 4 Human Approval Gate in the GCAC Remediation Hub.'
        ].filter(l => l !== null);
        return lines.join('\n') + '\n';
    }

    if (result.isAwaitingFinalApproval && !result.finalGateBlocked) {
        const checklist = result.evidenceChecklist || result.securityReview?.evidenceChecklist || null;
        const lines = [
            '',
            '---',
            '### Gate 8 — Final Human Sign-Off Required',
            `- **Finding ID**: \`${vulnId}\``,
            '- **Workflow Status**: `AWAITING APPROVAL`',
            `- **Post-Fix Validation Outcome**: \`${result.securityValidationOutcome || (result.validation ? (result.validation.outcome || result.validation.status) : 'NOT VERIFIED')}\``,
            `- **Security Review Status**: \`${checklist?.finalReviewStatus || result.securityReview?.rating || 'NOT VERIFIED'}\``,
            checklist ? `- **Evidence Completeness**: ${checklist.completionSummary} (Failed: ${checklist.failedCount}, Missing: ${checklist.missingCount})` : null
        ].filter(l => l !== null);

        if (checklist?.isSecretFinding && Array.isArray(checklist.secretRemediationActions) && checklist.secretRemediationActions.length > 0) {
            lines.push('- **Secret Remediation Manual Controls Required Before Operational Closure**:');
            for (const act of checklist.secretRemediationActions) {
                lines.push(`  - \`${act.id}\`: ${act.action}`);
            }
        }

        lines.push(
            '',
            '**Required Action:**',
            `- Sign off in Copilot Chat: \`@vulnerability-orchestrator /final-approve ${vulnId}\``,
            '- Or complete Final Sign-off in the GCAC Remediation Hub.'
        );
        return lines.join('\n') + '\n';
    }

    return '';
}

function formatTerminalConclusionMarkdown(vulnId, result) {
    const checklist = result.evidenceChecklist || result.securityReview?.evidenceChecklist || null;

    if (result.finalGateBlocked || (!result.isCompleted && !result.isAwaitingApproval && !result.isAwaitingFinalApproval)) {
        const val = result.validation || {};
        const diagSummary = stripDecorativeSymbols(
            val.rootError || val.summary || result.failureReason || 'Post-fix validation did not pass.'
        );
        const testsLine = val.countsKnown === false
            ? `Tests Unknown (Build/Execution did not run tests; Exit Code: ${val.exitCode ?? 'N/A'})`
            : `Passed: ${val.testsPassed ?? 0}, Failed: ${val.testsFailed ?? 0}, Total: ${val.testsTotal ?? 0}, Exit Code: ${val.exitCode ?? 'N/A'}`;
        const nextAction = result.retryEligibility?.canReviseFix
            ? 'Review Failure / Revise Fix in the GCAC Remediation Hub (generates revised patch and enforces fresh Stage 4 review).'
            : (result.retryEligibility?.retryEligible
                ? `Retry Stage ${result.failedStage || 6} in the GCAC Remediation Hub after resolving transient condition.`
                : 'Inspect diagnostics and remediate root cause before re-running validation.');

        const lines = [
            '',
            '---',
            '### Workflow Ended — Validation Failed',
            `- **Finding ID**: \`${vulnId}\``,
            `- **Workflow Status**: \`${result.workflowLifecycle || 'COMPLETED'}\``,
            `- **Validation Outcome**: \`${result.securityValidationOutcome || val.machineStatus || val.status || 'FAILED'}\``,
            '- **Final Review Status**: `BLOCKED` — Post-fix validation failed (Final sign-off prohibited)',
            `- **Failure Category**: \`${result.failureCategory || val.failureCategory || 'VALIDATION_FAILED'}\``,
            `- **Test Execution Summary**: ${testsLine}`,
            checklist ? `- **Evidence Completeness**: ${checklist.completionSummary} (Failed: ${checklist.failedCount}, Missing: ${checklist.missingCount})` : null,
            `- **Diagnostics**: ${diagSummary}`,
            `- **Next Required Action**: ${nextAction}`
        ].filter(l => l !== null);

        if (checklist?.isSecretFinding && Array.isArray(checklist.secretRemediationActions) && checklist.secretRemediationActions.length > 0) {
            lines.push('- **Manual Secret Controls Still Required**:');
            for (const act of checklist.secretRemediationActions) {
                lines.push(`  - \`${act.id}\`: ${act.action}`);
            }
        }
        return lines.join('\n') + '\n';
    }

    if (result.isCompleted) {
        const lines = [
            '',
            '---',
            '### Workflow Concluded — Verified and Signed Off',
            `- **Finding ID**: \`${vulnId}\``,
            `- **Workflow Status**: \`${result.workflowLifecycle || 'COMPLETED'}\``,
            `- **Validation Outcome**: \`${result.securityValidationOutcome || 'PASSED'}\``,
            `- **Final Review Status**: \`${checklist?.finalReviewStatus || 'READY FOR REVIEW'}\``,
            checklist ? `- **Evidence Completeness**: ${checklist.completionSummary}` : null,
            `- **Report Artifact**: \`${stripDecorativeSymbols(result.reportPath || 'N/A')}\``,
            `- **Recorded Status**: \`${stripDecorativeSymbols(result.status || 'Completed')}\``,
            '- **Next Step**: Hand off verified local changes to Application Team CI/CD verification outside agent boundary.'
        ].filter(l => l !== null);

        if (checklist?.isSecretFinding && Array.isArray(checklist.secretRemediationActions) && checklist.secretRemediationActions.length > 0) {
            lines.push('- **Manual Secret Controls Checklist**:');
            for (const act of checklist.secretRemediationActions) {
                lines.push(`  - \`${act.id}\`: ${act.action}`);
            }
        }
        return lines.join('\n') + '\n';
    }

    return '';
}

function formatErrorMarkdown(title, message) {
    return `\n\n**${stripDecorativeSymbols(title)}**: ${stripDecorativeSymbols(message)}\n`;
}

module.exports = {
    EMOJI_AND_DECORATIVE_REGEX,
    stripDecorativeSymbols,
    getStageDisplayName,
    formatHelpMarkdown,
    formatRunHeaderMarkdown,
    formatStageEventMarkdown,
    formatGateMarkdown,
    formatTerminalConclusionMarkdown,
    formatErrorMarkdown
};

