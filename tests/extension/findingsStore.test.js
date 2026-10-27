const assert = require('assert');
const path = require('path');
const fs = require('fs');

const {
    NormalizedFinding,
    SEVERITY_LEVELS,
    SCANNER_STATUS,
    generateFindingFingerprint,
    maskSensitiveEvidence
} = require('../../extension/scanning/findingModel');
const { FindingsStore } = require('../../extension/scanning/findingsStore');
const { getCombinedFindings } = require('../../extension/extension');
const { loadVulnerabilities } = require('../../extension/csvParser');

const workspaceRoot = path.resolve(__dirname, '../..');
const liveCsvPath = path.join(workspaceRoot, 'vulnerability', 'vulnerabilities.csv');

async function run() {
    console.log('[TEST SUITE] Normalized Findings Model & Storage Tests');

    const tempDir = path.join(workspaceRoot, 'output', 'test-store');
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    fs.mkdirSync(tempDir, { recursive: true });

    const store = new FindingsStore(workspaceRoot, tempDir);

    // 1. NormalizedFinding Instantiation & Fingerprint Stability
    const fp1 = generateFindingFingerprint('SEC-001', 'sample-repos/payments-api/appsettings.json', 'sk_live_secret');
    const fp2 = generateFindingFingerprint('SEC-001', 'sample-repos/payments-api/appsettings.json', 'sk_live_secret');
    const fpDifferentFile = generateFindingFingerprint('SEC-001', 'sample-repos/payments-api/web.config', 'sk_live_secret');
    const fpDifferentRule = generateFindingFingerprint('SEC-002', 'sample-repos/payments-api/appsettings.json', 'sk_live_secret');

    assert.strictEqual(fp1, fp2, 'Same rule, file, and code context must generate identical fingerprint');
    assert.notStrictEqual(fp1, fpDifferentFile, 'Different file must generate different fingerprint');
    assert.notStrictEqual(fp1, fpDifferentRule, 'Different rule must generate different fingerprint');
    console.log('  ✓ Location-resilient finding fingerprinting verified');

    // 2. NormalizedFinding to CSV Compatible Record
    const finding1 = new NormalizedFinding({
        scanId: 'SCAN-20261025-01',
        scannerId: 'secrets-config',
        scannerVersion: '1.2.0',
        ruleId: 'SEC-001',
        title: 'Hardcoded API Secret or Private Key',
        description: 'Hardcoded sensitive secret or API key identified.',
        severity: SEVERITY_LEVELS.HIGH,
        cwe: 'CWE-798',
        confidence: 'High',
        filePath: 'sample-repos/payments-api/appsettings.json',
        line: 14,
        column: 22,
        evidence: 'sk_live_****3221',
        remediationGuidance: 'Externalize credentials into environment variables.'
    });

    const csvRecord = finding1.toCsvCompatibleRecord();
    assert(csvRecord.Vulnerability_ID.startsWith('SCAN-SEC-001-'), 'Vulnerability_ID must be formatted with prefix');
    assert.strictEqual(csvRecord.CVE_ID, 'CWE-798', 'CVE_ID should reflect CWE when CVE is absent');
    assert.strictEqual(csvRecord.Title, 'Hardcoded API Secret or Private Key');
    assert.strictEqual(csvRecord.Severity, 'HIGH');
    assert.strictEqual(csvRecord.Remediation_Status, 'Pending');
    assert.strictEqual(csvRecord.Source_Type, 'SCANNER');
    assert.strictEqual(csvRecord.Scanner_ID, 'secrets-config');
    assert.strictEqual(csvRecord.Location_Path, 'sample-repos/payments-api/appsettings.json');
    assert.strictEqual(csvRecord.Line_Number, '14');
    console.log('  ✓ NormalizedFinding adaptation to 19-column CSV schema verified');

    // 3. FindingsStore Persistence & Deduplication
    const ingested = store.ingestFindings([finding1]);
    assert.strictEqual(ingested.newCount, 1);
    assert.strictEqual(ingested.updatedCount, 0);

    // Ingest duplicate finding with same fingerprint
    const ingestedAgain = store.ingestFindings([finding1]);
    assert.strictEqual(ingestedAgain.newCount, 0, 'Duplicate finding must not be added as new row');
    assert.strictEqual(ingestedAgain.updatedCount, 1, 'Duplicate finding should update existing row');

    // Verify findings.json disk persistence
    const findingsJsonPath = path.join(tempDir, 'findings.json');
    assert(fs.existsSync(findingsJsonPath), 'findings.json must exist on disk');
    const persisted = JSON.parse(fs.readFileSync(findingsJsonPath, 'utf-8'));
    assert.strictEqual(persisted.length, 1);
    assert.strictEqual(persisted[0].findingFingerprint, finding1.findingFingerprint);
    console.log('  ✓ Deduplication by fingerprint and disk persistence verified');

    // 4. Status Preservation Across Scans
    // Update status to IN_PROGRESS
    store.updateFindingStatus(finding1.fingerprint, 'IN_PROGRESS', { stage: 3 });
    const updatedFinding = store.getFindingByFingerprint(finding1.fingerprint);
    assert.strictEqual(updatedFinding.status, 'IN_PROGRESS');

    // Re-scan ingests finding again: status must NOT reset to PENDING
    store.ingestFindings([finding1]);
    const reIngested = store.getFindingByFingerprint(finding1.fingerprint);
    assert.strictEqual(reIngested.status, 'IN_PROGRESS', 'Subsequent scans must not reset active remediation status to PENDING');
    console.log('  ✓ Remediation status preservation across re-scans verified');

    // 5. Bounded Retention of Scan History (Max 20 sessions)
    for (let i = 1; i <= 25; i++) {
        store.recordScanSession({
            scanId: `SCAN-TEST-${i}`,
            timestamp: new Date().toISOString(),
            status: 'Completed',
            targetDir: workspaceRoot,
            durationMs: 150,
            scannersCount: 2,
            findingsSummary: { total: 1, critical: 0, high: 1, medium: 0, low: 0 }
        });
    }

    const history = store.getScanHistory();
    assert.strictEqual(history.length, 20, 'Scan history must be bounded to max 20 sessions');
    assert.strictEqual(history[0].scanId, 'SCAN-TEST-25', 'Latest session must be at head of history');
    assert.strictEqual(history[19].scanId, 'SCAN-TEST-6', 'Oldest session past 20 must be purged');
    console.log('  ✓ Bounded scan history retention (max 20 sessions) verified');

    // 6. Non-Destructive getCombinedFindings Integrity
    const csvMtimeBefore = fs.statSync(liveCsvPath).mtimeMs;
    const combined = await getCombinedFindings(liveCsvPath, store);

    const baseCsvCount = loadVulnerabilities(liveCsvPath).length;
    assert.strictEqual(combined.length, baseCsvCount + 1, 'Combined findings must include CSV records plus scanned finding');
    
    // Ensure live CSV file was NOT modified
    const csvMtimeAfter = fs.statSync(liveCsvPath).mtimeMs;
    assert.strictEqual(csvMtimeBefore, csvMtimeAfter, 'vulnerabilities.csv file must not be modified by combined intake');
    console.log(`  ✓ getCombinedFindings united ${baseCsvCount} CSV + 1 scanned record without mutating vulnerabilities.csv`);

    // Clean up temp dir
    try {
        if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {}
}

module.exports = { run };

if (require.main === module) {
    run().catch(err => {
        console.error(err);
        process.exit(1);
    });
}
