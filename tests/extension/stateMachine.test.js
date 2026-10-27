const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { RemediationEngine } = require('../../extension/remediationEngine');

const workspaceRoot = path.resolve(__dirname, '../..');

async function run() {
    console.log('[TEST SUITE] Workflow State Machine & Human Approval Gate Tests');

    const tempDir = path.join(workspaceRoot, 'tests', 'fixtures', 'state-machine');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const tempCsv = path.join(tempDir, 'vulnerabilities.csv');
    const sourceCsv = path.join(workspaceRoot, 'vulnerability', 'vulnerabilities.csv');
    fs.copyFileSync(sourceCsv, tempCsv);

    const engine = new RemediationEngine(workspaceRoot, tempCsv);

    try {
        // 1. Approval Gate Bypass Prevention Test:
        // Attempting to invoke final approval on a fresh finding without Stage 4 approval MUST fail
        let bypassCaught = false;
        try {
            await engine.executePipeline('VUL-POC-006', {
                isHumanApproved: true,
                isFinalApproved: true
            });
        } catch (err) {
            bypassCaught = true;
            assert(err.message.includes('Approval Gate Bypass Blocked'), `Expected bypass block error, got: ${err.message}`);
        }
        assert.strictEqual(bypassCaught, true, 'Direct final approval MUST be blocked without Stage 4 approval');
        console.log('  ✓ Approval gate bypass blocked: Direct final approval rejected without Stage 4 authorization');

        // 2. Concurrency Lock Test:
        // Trying to run two simultaneous pipelines on the same vulnerability ID must be prevented
        engine.activeRuns.add('LOCK-TEST-001');
        let lockCaught = false;
        try {
            await engine.executePipeline('LOCK-TEST-001');
        } catch (err) {
            lockCaught = true;
            assert(err.message.includes('Duplicate concurrent execution blocked'), `Expected concurrency lock error, got: ${err.message}`);
        } finally {
            engine.activeRuns.delete('LOCK-TEST-001');
        }
        assert.strictEqual(lockCaught, true, 'Concurrent execution on same vulnerability ID must be blocked');
        console.log('  ✓ Run concurrency lock: Duplicate simultaneous runs prevented');

        // 3. Rollback & Snapshot Test:
        // Create a dummy source file, snapshot it, modify it, then rollback
        const dummyFile = path.join(tempDir, 'VulnerableService.cs');
        fs.writeFileSync(dummyFile, 'public class VulnerableService { /* ORIGINAL */ }', 'utf-8');

        const testId = 'ROLLBACK-TEST-001';
        engine.snapshotOriginalFile(testId, dummyFile);

        // Simulate modification by remediation
        fs.writeFileSync(dummyFile, 'public class VulnerableService { /* MODIFIED BY PATCH */ }', 'utf-8');
        assert(fs.readFileSync(dummyFile, 'utf-8').includes('MODIFIED'));

        // Perform rollback
        const restored = engine.rollbackFile(testId, dummyFile);
        assert.strictEqual(restored, true, 'Rollback should return true when file is restored');
        assert(fs.readFileSync(dummyFile, 'utf-8').includes('ORIGINAL'), 'File must be restored to original contents');
        console.log('  ✓ Safe rollback: Snapshot restored cleanly without destroying unrelated files');

        // 4. Run State Persistence Test:
        const sampleState = {
            vulnerabilityId: testId,
            stage: 4,
            status: 'AWAITING_HUMAN_APPROVAL',
            stage4Approved: false,
            stage6Approved: false,
            updatedAt: new Date().toISOString()
        };
        engine.saveRunState(testId, sampleState);
        const loadedState = engine.loadRunState(testId);
        assert.strictEqual(loadedState.vulnerabilityId, testId);
        assert.strictEqual(loadedState.stage, 4);
        assert.strictEqual(loadedState.status, 'AWAITING_HUMAN_APPROVAL');
        console.log('  ✓ Run state persistence: State preserved on disk for reload resilience');

    } finally {
        // Clean up test state dir
        try {
            const remDir = path.join(workspaceRoot, 'remediation-output', 'ROLLBACK-TEST-001');
            if (fs.existsSync(remDir)) fs.rmSync(remDir, { recursive: true, force: true });
            if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (e) {}
    }
}

module.exports = { run };
if (require.main === module) {
    run().catch(err => {
        console.error(err);
        process.exit(1);
    });
}
