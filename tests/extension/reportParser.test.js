const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { loadVulnerabilityDetails, loadAllReports, isReportMatchForVulnerability, extractTimingsFromTrace } = require('../../extension/reportParser');

const workspaceRoot = path.resolve(__dirname, '../..');

function run() {
    console.log('[TEST SUITE] Report Parser & Evidence Discovery Tests');

    // 1. isReportMatchForVulnerability unit tests
    assert.strictEqual(
        isReportMatchForVulnerability('sql_injection_in_payment_processing_controller_vul_poc_001.md', 'VUL-POC-001'),
        true,
        'Should match underscored filename to hyphenated vuln ID'
    );
    assert.strictEqual(
        isReportMatchForVulnerability('VUL-POC-007_Hardcoded_API_Secret_Key_in_AppSettings.md', 'VUL-POC-007'),
        true,
        'Should match hyphenated prefix report'
    );
    assert.strictEqual(
        isReportMatchForVulnerability('path_traversal_in_file_controller_gcas_e2e_004.md', 'GCAS-E2E-004'),
        true,
        'Should match GCAS E2E underscored report'
    );

    // Collision resistance
    assert.strictEqual(
        isReportMatchForVulnerability('sql_injection_vul_poc_0010.md', 'VUL-POC-001'),
        false,
        'Must NOT match VUL-POC-001 to VUL-POC-0010'
    );
    assert.strictEqual(
        isReportMatchForVulnerability('remediation_report.md', 'VUL-POC-001'),
        false,
        'Must NOT match generic non-associated report'
    );
    console.log('  ✓ Verified report ID normalization and collision resistance');

    // 2. Discover all reports in output/
    const vulnsWithReports = [
        'VUL-POC-001',
        'VUL-POC-002',
        'VUL-POC-003',
        'VUL-POC-004',
        'VUL-POC-007',
        'VUL-POC-008',
        'VUL-POC-009',
        'GCAS-E2E-001',
        'GCAS-E2E-002',
        'GCAS-E2E-004',
        'GCAS-E2E-005'
    ];

    for (const vulnId of vulnsWithReports) {
        const det = loadVulnerabilityDetails(workspaceRoot, vulnId);
        assert(det.hasEvidence, `Vulnerability ${vulnId} should have evidence discovered in output/`);
        assert(det.reportMarkdown && det.reportMarkdown.length > 50, `Vulnerability ${vulnId} reportMarkdown should be non-empty`);
    }
    console.log(`  ✓ 100% discovery rate: all ${vulnsWithReports.length} output reports resolved cleanly`);

    // 3. Test non-existent report
    const nonExistent = loadVulnerabilityDetails(workspaceRoot, 'NON-EXISTENT-999');
    assert.strictEqual(nonExistent.hasEvidence, false, 'Non-existent ID should have hasEvidence: false');
    assert.strictEqual(nonExistent.reportMarkdown, '', 'Non-existent ID should have empty reportMarkdown');
    console.log('  ✓ Handled missing report cleanly without false positives');

    // 4. Test missing timestamps return null, NOT fake fallbacks
    const emptyTimings = extractTimingsFromTrace('');
    assert.strictEqual(emptyTimings, null, 'Empty trace should return null timings');

    const traceWithoutDeltas = `[2026-10-09 06:47:36 UTC] [DISCOVERY] Starting discovery`;
    const singleTimings = extractTimingsFromTrace(traceWithoutDeltas);
    assert(singleTimings !== null, 'Single timestamp should parse');
    assert.strictEqual(singleTimings.analysisDurationSec, null, 'analysisDurationSec must be null when missing');
    assert.strictEqual(singleTimings.testDurationSec, null, 'testDurationSec must be null when missing');
    assert.strictEqual(singleTimings.remediationDurationSec, null, 'remediationDurationSec must be null when missing');
    console.log('  ✓ Timing telemetry: Missing durations return null instead of synthetic fallbacks');

    // 5. loadAllReports discovery test
    const allReports = loadAllReports(workspaceRoot);
    assert(allReports.length >= 10, `Expected at least 10 reports, found ${allReports.length}`);
    console.log(`  ✓ loadAllReports cataloged ${allReports.length} reports across output directories`);
}

module.exports = { run };
if (require.main === module) {
    run();
}
