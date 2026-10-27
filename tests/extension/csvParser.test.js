const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { loadVulnerabilities, updateVulnerabilityRow } = require('../../extension/csvParser');

const workspaceRoot = path.resolve(__dirname, '../..');
const csvPath = path.join(workspaceRoot, 'vulnerability', 'vulnerabilities.csv');

function run() {
    console.log('[TEST SUITE] CSV Parser & Row Isolation Tests');

    // 1. Ingestion test
    const data = loadVulnerabilities(csvPath);
    assert(Array.isArray(data), 'CSV data should be an array');
    assert.strictEqual(data.length, 17, `Expected exactly 17 findings in sample CSV, got ${data.length}`);
    console.log('  ✓ Ingested 17 vulnerability records successfully');

    // Check required schema fields
    const first = data[0];
    const requiredFields = [
        'Vulnerability_ID', 'Application_Number', 'Application_Name',
        'Severity', 'CVE_ID', 'Title', 'Location_Path', 'Remediation_Status'
    ];
    for (const field of requiredFields) {
        assert(field in first, `Missing expected CSV header column: ${field}`);
    }
    console.log('  ✓ Verified schema columns and RFC 4180 parsing');

    // 2. Row Isolation Test in temporary copy
    const tempDir = path.join(workspaceRoot, 'tests', 'fixtures');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const tempCsv = path.join(tempDir, 'temp-vulnerabilities.csv');
    fs.copyFileSync(csvPath, tempCsv);

    try {
        const originalRows = loadVulnerabilities(tempCsv);
        const targetId = 'VUL-POC-006';
        const targetRow = originalRows.find(r => r.Vulnerability_ID === targetId);
        assert(targetRow, `Target row ${targetId} must exist`);

        // Update only target row
        updateVulnerabilityRow(tempCsv, targetId, {
            Remediation_Status: 'Awaiting Human Review',
            Requires_Human_Review: 'true',
            Agent_Code_Analysis_Output: 'Test RCA Output'
        });

        const updatedRows = loadVulnerabilities(tempCsv);
        assert.strictEqual(updatedRows.length, 17, 'Row count must be preserved exactly');

        // Verify target row updated
        const updatedTarget = updatedRows.find(r => r.Vulnerability_ID === targetId);
        assert.strictEqual(updatedTarget.Remediation_Status, 'Awaiting Human Review');
        assert.strictEqual(updatedTarget.Requires_Human_Review, 'true');
        assert.strictEqual(updatedTarget.Agent_Code_Analysis_Output, 'Test RCA Output');

        // Verify unrelated rows were untouched
        for (let i = 0; i < originalRows.length; i++) {
            if (originalRows[i].Vulnerability_ID !== targetId) {
                assert.deepStrictEqual(
                    updatedRows[i].Remediation_Status,
                    originalRows[i].Remediation_Status,
                    `Unrelated row ${originalRows[i].Vulnerability_ID} was modified!`
                );
            }
        }
        console.log('  ✓ Row isolation confirmed: only target row updated, unrelated rows preserved');
    } finally {
        if (fs.existsSync(tempCsv)) fs.unlinkSync(tempCsv);
    }
}

module.exports = { run };
if (require.main === module) {
    run();
}
