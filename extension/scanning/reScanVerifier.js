const path = require('path');
const fs = require('fs');
const { VERIFICATION_STATUS } = require('./findingModel');

/**
 * Post-Remediation Re-Scan Verification Engine
 * Performs genuine before-and-after finding comparison to determine whether
 * a vulnerability has been verified as RESOLVED, STILL PRESENT, INCONCLUSIVE,
 * NOT VERIFIED, or REGRESSION DETECTED.
 */
class ReScanVerifier {
    /**
     * @param {import('./scanController').ScanController|string} scanControllerOrWorkspaceRoot 
     * @param {import('./scanController').ScanController} [maybeScanController]
     */
    constructor(scanControllerOrWorkspaceRoot, maybeScanController) {
        if (maybeScanController) {
            this.workspaceRoot = scanControllerOrWorkspaceRoot;
            this.scanController = maybeScanController;
        } else {
            this.scanController = scanControllerOrWorkspaceRoot;
            this.workspaceRoot = scanControllerOrWorkspaceRoot ? scanControllerOrWorkspaceRoot.workspaceRoot : process.cwd();
        }
    }

    /**
     * Executes targeted re-scan and computes definitive post-remediation verification status.
     * 
     * @param {object} params
     * @param {object} params.originalFinding - The original baseline finding record
     * @param {object} [params.postFixTestResult] - The result from Stage 6 post-fix test runner
     * @param {string} [params.targetFilePath] - The source file that was remediated
     * @returns {Promise<{
     *   status: string, // RESOLVED | STILL PRESENT | INCONCLUSIVE | NOT VERIFIED | REGRESSION DETECTED
     *   reason: string,
     *   summary: string,
     *   isResolved: boolean,
     *   beforeFingerprint: string,
     *   reScanDurationMs: number,
     *   stillPresent: boolean,
     *   newFindingsCount: number,
     *   evidence: string[],
     *   evidenceMarkdown: string,
     *   scannerDetails: { id: string, name: string, version: string }
     * }>}
     */
    async verifyRemediation(params = {}) {
        const originalFinding = params.originalFinding;
        const postFixTestResult = params.postFixTestResult || params.testResult;
        const targetFilePath = params.targetFilePath || params.targetPath;

        if (!originalFinding) {
            const reason = 'Missing original finding context.';
            const md = '### ⚠️ Re-Scan Verification\n- Status: `NOT VERIFIED` (No original finding supplied)\n';
            return {
                status: VERIFICATION_STATUS.NOT_VERIFIED,
                isResolved: false,
                reason,
                summary: reason,
                beforeFingerprint: '',
                reScanDurationMs: 0,
                stillPresent: false,
                newFindingsCount: 0,
                evidence: [md],
                evidenceMarkdown: md,
                scannerDetails: { id: 'unknown', name: 'Unknown', version: '' }
            };
        }

        const scannerId = originalFinding.scannerId || 
            (originalFinding.Source_Classification === 'LocalScanner' ? 'secrets-config' : 'secrets-config');
        
        const scanner = this.scanController && this.scanController.scanners ? this.scanController.scanners.get(scannerId) : null;
        if (!scanner) {
            const reason = `Original scanner '${scannerId}' is not registered or unavailable.`;
            const md = `### ⚠️ Re-Scan Verification\n- Scanner: \`${scannerId}\`\n- Status: \`NOT VERIFIED\` (Scanner unavailable on local host)\n`;
            return {
                status: VERIFICATION_STATUS.NOT_VERIFIED,
                isResolved: false,
                reason,
                summary: reason,
                beforeFingerprint: originalFinding.findingFingerprint || '',
                reScanDurationMs: 0,
                stillPresent: false,
                newFindingsCount: 0,
                evidence: [md],
                evidenceMarkdown: md,
                scannerDetails: { id: scannerId, name: scannerId, version: '' }
            };
        }

        // Check scanner availability
        const avail = await scanner.isAvailable();
        if (!avail.available) {
            const reason = `Scanner '${scanner.name}' runtime is not installed: ${avail.reason}`;
            const md = `### ⚠️ Re-Scan Verification: ${scanner.name}\n- Status: \`NOT VERIFIED\`\n- Reason: Required runtime unavailable on machine (${avail.reason})\n`;
            return {
                status: VERIFICATION_STATUS.NOT_VERIFIED,
                isResolved: false,
                reason,
                summary: reason,
                beforeFingerprint: originalFinding.findingFingerprint || '',
                reScanDurationMs: 0,
                stillPresent: false,
                newFindingsCount: 0,
                evidence: [md],
                evidenceMarkdown: md,
                scannerDetails: { id: scanner.id, name: scanner.name, version: '' }
            };
        }

        // Resolve scan target: specific remediated file or repository folder
        const scanTarget = targetFilePath && fs.existsSync(targetFilePath)
            ? targetFilePath
            : (originalFinding.filePath ? path.join(this.workspaceRoot, originalFinding.filePath) : this.workspaceRoot);

        const startTime = Date.now();
        let reScanResult;

        try {
            reScanResult = await scanner.scan(this.workspaceRoot, scanTarget, {
                scanId: `rescan-${Date.now()}`
            });
        } catch (e) {
            return {
                status: VERIFICATION_STATUS.NOT_VERIFIED,
                reason: `Scanner execution failed during re-scan: ${e.message}`,
                beforeFingerprint: originalFinding.findingFingerprint || '',
                reScanDurationMs: Date.now() - startTime,
                stillPresent: false,
                newFindingsCount: 0,
                evidenceMarkdown: `### ⚠️ Re-Scan Verification: ${scanner.name}\n- Status: \`NOT VERIFIED\`\n- Error: ${e.message}\n`,
                scannerDetails: { id: scanner.id, name: scanner.name, version: scanner.version }
            };
        }

        const durationMs = Date.now() - startTime;
        const findings = reScanResult.findings || [];

        // 1. Check if the original finding is still present (matching fingerprint OR matching ruleId + target file)
        const targetRelFile = (originalFinding.filePath || originalFinding.Location_Path || '').replace(/\\/g, '/').toLowerCase();
        const ruleId = (originalFinding.ruleId || originalFinding.CVE_ID || '').toUpperCase();

        const matchingFinding = findings.find(f => {
            if (originalFinding.findingFingerprint && f.findingFingerprint === originalFinding.findingFingerprint) {
                return true;
            }
            const fFile = (f.filePath || '').replace(/\\/g, '/').toLowerCase();
            const fRule = (f.ruleId || '').toUpperCase();
            return fRule === ruleId && fFile.endsWith(path.basename(targetRelFile));
        });

        // 2. Check for regressions (new security findings introduced in same file)
        const regressions = findings.filter(f => {
            if (matchingFinding && f === matchingFinding) return false;
            const fFile = (f.filePath || '').replace(/\\/g, '/').toLowerCase();
            return fFile.endsWith(path.basename(targetRelFile));
        });

        let finalStatus = VERIFICATION_STATUS.RESOLVED;
        let explanation = '';

        if (matchingFinding) {
            finalStatus = VERIFICATION_STATUS.STILL_PRESENT;
            explanation = `The original vulnerability (${ruleId}) is still detected by ${scanner.name} at line ${matchingFinding.line}.`;
        } else if (regressions.length > 0) {
            finalStatus = VERIFICATION_STATUS.REGRESSION_DETECTED;
            explanation = `The original vulnerability is resolved, but ${regressions.length} new security finding(s) were introduced: ${regressions.map(r => r.ruleId).join(', ')}.`;
        } else if (postFixTestResult && (postFixTestResult.status === 'FAIL' || postFixTestResult.passed === false)) {
            finalStatus = VERIFICATION_STATUS.REGRESSION_DETECTED;
            explanation = 'The security finding is no longer detected, but post-fix test execution failed.';
        } else if (reScanResult.coverage && /(^|\s)0%/.test(reScanResult.coverage)) {
            finalStatus = VERIFICATION_STATUS.INCONCLUSIVE;
            explanation = `Re-scan coverage was incomplete (${reScanResult.coverage}). Outcome is inconclusive.`;
        } else {
            finalStatus = VERIFICATION_STATUS.RESOLVED;
            explanation = `Original security vulnerability (${ruleId}) is completely absent from targeted re-scan (${scanner.name} v${scanner.version}) with 0 regressions.`;
        }

        // Format Markdown Comparison Evidence
        const evidenceMarkdown = [
            `### 🔬 Post-Remediation Verification & Re-Scan Audit`,
            `- **Scanner**: \`${scanner.name}\` (Version: \`${scanner.version}\`)`,
            `- **Verification Status**: **\`${finalStatus}\`**`,
            `- **Target Path**: \`${path.relative(this.workspaceRoot, scanTarget) || '.'}\``,
            `- **Original Rule ID**: \`${ruleId}\``,
            `- **Baseline Fingerprint**: \`${originalFinding.findingFingerprint || 'N/A'}\``,
            `- **Re-Scan Duration**: \`${(durationMs / 1000).toFixed(2)}s\``,
            `- **Findings Detected Post-Fix**: \`${findings.length}\``,
            `- **Evaluation Summary**: ${explanation}`,
            ``
        ].join('\n');

        return {
            status: finalStatus,
            isResolved: finalStatus === VERIFICATION_STATUS.RESOLVED,
            reason: explanation,
            summary: explanation,
            beforeFingerprint: originalFinding.findingFingerprint || '',
            reScanDurationMs: durationMs,
            stillPresent: !!matchingFinding,
            newFindingsCount: regressions.length,
            evidence: [evidenceMarkdown],
            evidenceMarkdown,
            scannerDetails: {
                id: scanner.id,
                name: scanner.name,
                version: scanner.version
            }
        };
    }
}

module.exports = {
    ReScanVerifier
};
