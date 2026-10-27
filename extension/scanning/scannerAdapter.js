const { SCANNER_STATUS } = require('./findingModel');

/**
 * Base Scanner Adapter Contract for GCAC Vulnerability Remediation Hub
 * Each local scanner must implement this contract.
 */
class ScannerAdapter {
    /**
     * @param {object} metadata
     * @param {string} metadata.id
     * @param {string} metadata.name
     * @param {string} metadata.version
     * @param {string[]} metadata.supportedLanguages
     * @param {string[]} metadata.supportedCategories
     */
    constructor(metadata = {}) {
        this.id = metadata.id || 'base-scanner';
        this.name = metadata.name || 'Base Scanner';
        this.version = metadata.version || '1.0.0';
        this.supportedLanguages = metadata.supportedLanguages || ['csharp', 'dotnet'];
        this.supportedCategories = metadata.supportedCategories || ['Security'];
        this.status = SCANNER_STATUS.READY;
        this.statusReason = '';
        this.activeProcess = null;
    }

    /**
     * Checks whether the scanner binary or runtime is available on the local machine
     * @returns {Promise<{ available: boolean, version: string, reason?: string }>}
     */
    async isAvailable() {
        throw new Error(`isAvailable() not implemented in ${this.constructor.name}`);
    }

    /**
     * Validates scanner configuration
     * @param {object} config 
     * @returns {{ valid: boolean, errors?: string[] }}
     */
    validateConfig(config = {}) {
        return { valid: true, errors: [] };
    }

    /**
     * Executes the scan on the specified target path
     * @param {string} workspaceRoot 
     * @param {string} targetPath 
     * @param {object} options 
     * @returns {Promise<{
     *   scannerId: string,
     *   status: string,
     *   findings: import('./findingModel').NormalizedFinding[],
     *   durationMs: number,
     *   errors: string[],
     *   warnings: string[],
     *   coverage: string
     * }>}
     */
    async scan(workspaceRoot, targetPath, options = {}) {
        throw new Error(`scan() not implemented in ${this.constructor.name}`);
    }

    /**
     * Executes targeted re-scan on a specific file/rule for post-remediation verification
     * @param {string} workspaceRoot 
     * @param {string} targetPath 
     * @param {string} ruleId 
     * @param {string} originalFingerprint 
     * @param {object} options 
     */
    async reScan(workspaceRoot, targetPath, ruleId, originalFingerprint, options = {}) {
        // Default implementation runs scan on target and filters by rule/fingerprint
        const scanResult = await this.scan(workspaceRoot, targetPath, options);
        const matchingFinding = scanResult.findings.find(f => 
            f.ruleId === ruleId || f.findingFingerprint === originalFingerprint
        );
        return {
            scannerId: this.id,
            status: scanResult.status,
            stillPresent: !!matchingFinding,
            finding: matchingFinding || null,
            durationMs: scanResult.durationMs,
            errors: scanResult.errors,
            warnings: scanResult.warnings
        };
    }

    /**
     * Cancels any currently executing child process
     */
    cancel() {
        if (this.activeProcess && !this.activeProcess.killed) {
            try {
                this.activeProcess.kill('SIGTERM');
            } catch (e) {}
            this.status = SCANNER_STATUS.CANCELLED;
            this.statusReason = 'Scan cancelled by user';
        }
    }
}

module.exports = {
    ScannerAdapter
};
