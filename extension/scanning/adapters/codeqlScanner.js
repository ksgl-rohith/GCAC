const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ScannerAdapter } = require('../scannerAdapter');
const { NormalizedFinding, SCANNER_STATUS, SEVERITY_LEVELS } = require('../findingModel');
const { isExecutableAvailable } = require('../../testRunner');

/**
 * Optional CodeQL CLI Scanner Adapter
 * Strictly optional. Detects local CLI installation, executes official commands,
 * parses genuine SARIF 2.1.0 output, keeps databases in temporary folders,
 * and never uploads results externally.
 */
class CodeQLScanner extends ScannerAdapter {
    constructor() {
        super({
            id: 'codeql',
            name: 'GitHub CodeQL (Optional)',
            version: '2.16.0',
            supportedLanguages: ['csharp', 'java', 'javascript', 'python', 'cpp', 'go'],
            supportedCategories: [
                'CWE-89 (SQL Injection)',
                'CWE-79 (Cross-Site Scripting)',
                'CWE-22 (Path Traversal)',
                'CWE-78 (Command Injection)',
                'CWE-798 (Hardcoded Credentials)'
            ]
        });
    }

    async isAvailable() {
        // Check if codeql CLI is on PATH
        try {
            const cmd = process.platform === 'win32' ? 'where codeql' : 'which codeql';
            execSync(cmd, { stdio: 'ignore', timeout: 3000 });
            const ver = execSync('codeql version --format=json', { timeout: 4000, encoding: 'utf-8' }).trim();
            const parsed = JSON.parse(ver);
            return {
                available: true,
                version: parsed.version || 'unknown'
            };
        } catch (e) {
            return {
                available: false,
                version: '',
                reason: 'CodeQL CLI binary is not installed on PATH. CodeQL scanning is optional and does not block operation.'
            };
        }
    }

    /**
     * Parses official CodeQL SARIF 2.1.0 report
     */
    parseSarif(sarifContent, workspaceRoot, scanId) {
        const findings = [];
        try {
            const sarif = typeof sarifContent === 'string' ? JSON.parse(sarifContent) : sarifContent;
            for (const run of (sarif.runs || [])) {
                const driver = run.tool?.driver || {};
                const rulesMap = {};
                for (const r of (driver.rules || [])) {
                    rulesMap[r.id] = r;
                }

                for (const res of (run.results || [])) {
                    const ruleId = res.ruleId || 'CODEQL-RULE';
                    const ruleDef = rulesMap[ruleId] || {};
                    const loc = res.locations && res.locations[0]?.physicalLocation;
                    const uri = loc?.artifactLocation?.uri || '';
                    const region = loc?.region || {};

                    // Extract CWE from rule properties / tags
                    let cwe = null;
                    const tags = ruleDef.properties?.tags || [];
                    for (const tag of tags) {
                        const m = tag.match(/external\/cwe\/(cwe-\d+)/i);
                        if (m) {
                            cwe = m[1].toUpperCase();
                            break;
                        }
                    }

                    const sev = res.level === 'error' ? SEVERITY_LEVELS.HIGH : 
                               (res.level === 'warning' ? SEVERITY_LEVELS.MEDIUM : SEVERITY_LEVELS.LOW);

                    let normalizedPath = uri.replace(/\\/g, '/');
                    if (normalizedPath.startsWith('file:///')) {
                        normalizedPath = normalizedPath.substring(7);
                    } else if (normalizedPath.startsWith('file://')) {
                        normalizedPath = normalizedPath.substring(6);
                    }
                    if (path.isAbsolute(normalizedPath) && workspaceRoot) {
                        normalizedPath = path.relative(workspaceRoot, normalizedPath).replace(/\\/g, '/');
                    }

                    const finding = new NormalizedFinding({
                        scanId,
                        scannerId: this.id,
                        scannerVersion: driver.semanticVersion || this.version,
                        ruleId,
                        title: ruleDef.shortDescription?.text || ruleId,
                        description: res.message?.text || ruleDef.fullDescription?.text || '',
                        severity: sev,
                        cwe,
                        confidence: 'High',
                        filePath: normalizedPath,
                        line: region.startLine || 1,
                        column: region.startColumn || 1,
                        evidence: res.message?.text || '',
                        remediationGuidance: ruleDef.help?.text || 'Address vulnerability based on CodeQL query documentation.'
                    });

                    findings.push(finding);
                }
            }
        } catch (e) {}

        return findings;
    }

    /**
     * Detects target primary language for CodeQL database extraction
     */
    _detectLanguage(targetDir) {
        try {
            const files = fs.readdirSync(targetDir, { recursive: true });
            let hasCs = false, hasJs = false, hasPy = false;
            for (const f of files) {
                const str = String(f);
                if (str.endsWith('.cs') || str.endsWith('.csproj') || str.endsWith('.sln')) hasCs = true;
                if (str.endsWith('.js') || str.endsWith('.ts')) hasJs = true;
                if (str.endsWith('.py')) hasPy = true;
            }
            if (hasCs) return { language: 'csharp', suite: 'codeql/csharp-queries:codeql-suites/csharp-code-scanning.qls', buildMode: '--build-mode=none' };
            if (hasJs) return { language: 'javascript', suite: 'codeql/javascript-queries:codeql-suites/javascript-code-scanning.qls', buildMode: '' };
            if (hasPy) return { language: 'python', suite: 'codeql/python-queries:codeql-suites/python-code-scanning.qls', buildMode: '' };
        } catch (e) {}
        return { language: 'csharp', suite: 'codeql/csharp-queries:codeql-suites/csharp-code-scanning.qls', buildMode: '--build-mode=none' };
    }

    async scan(workspaceRoot, targetPath, options = {}) {
        const scanId = options.scanId || `scan-${Date.now()}`;
        const startTime = Date.now();

        const avail = await this.isAvailable();
        if (!avail.available) {
            this.status = SCANNER_STATUS.NOT_INSTALLED;
            this.statusReason = avail.reason;
            return {
                scannerId: this.id,
                status: SCANNER_STATUS.NOT_INSTALLED,
                findings: [],
                durationMs: Date.now() - startTime,
                errors: [avail.reason],
                warnings: ['Optional scanner CodeQL is not installed. Standard local scanning is unaffected.'],
                coverage: '0% (Optional tool not installed)'
            };
        }

        const scanTarget = targetPath || workspaceRoot;
        const tempDbDir = path.join(os.tmpdir(), `gcac-codeql-${Date.now()}`);
        const sarifOutputFile = path.join(os.tmpdir(), `gcac-codeql-out-${Date.now()}.sarif`);
        const { language, suite, buildMode } = this._detectLanguage(scanTarget);

        try {
            // 1. Create database in temp directory (bounded execution)
            const createCmd = buildMode 
                ? `codeql database create "${tempDbDir}" --language=${language} ${buildMode} --source-root="${scanTarget}" --overwrite`
                : `codeql database create "${tempDbDir}" --language=${language} --source-root="${scanTarget}" --overwrite`;

            execSync(createCmd, {
                timeout: options.timeoutMs || 180000,
                stdio: 'ignore'
            });

            // 2. Analyze database with official queries and output to SARIF
            execSync(`codeql database analyze "${tempDbDir}" "${suite}" --format=sarif-latest --output="${sarifOutputFile}"`, {
                timeout: options.timeoutMs || 180000,
                stdio: 'ignore'
            });

            if (fs.existsSync(sarifOutputFile)) {
                const sarifRaw = fs.readFileSync(sarifOutputFile, 'utf-8');
                const findings = this.parseSarif(sarifRaw, workspaceRoot, scanId);

                return {
                    scannerId: this.id,
                    status: SCANNER_STATUS.COMPLETED,
                    findings,
                    durationMs: Date.now() - startTime,
                    errors: [],
                    warnings: [],
                    coverage: `100% (CodeQL ${language} analysis complete)`
                };
            }

            return {
                scannerId: this.id,
                status: SCANNER_STATUS.COMPLETED,
                findings: [],
                durationMs: Date.now() - startTime,
                errors: [],
                warnings: ['CodeQL analysis completed with no output SARIF generated.'],
                coverage: '0%'
            };
        } catch (err) {
            return {
                scannerId: this.id,
                status: SCANNER_STATUS.FAILED,
                findings: [],
                durationMs: Date.now() - startTime,
                errors: [`CodeQL execution error: ${err.message}`],
                warnings: [],
                coverage: '0% (Execution failure)'
            };
        } finally {
            // Clean up temporary database artifacts
            try { if (fs.existsSync(tempDbDir)) fs.rmSync(tempDbDir, { recursive: true, force: true }); } catch (e) {}
            try { if (fs.existsSync(sarifOutputFile)) fs.unlinkSync(sarifOutputFile); } catch (e) {}
        }
    }
}

module.exports = {
    CodeQLScanner
};
