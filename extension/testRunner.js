const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Deterministic Test Runner for GCAC Vulnerability Remediation
 * 
 * Strict Principle:
 * ZERO SYNTHETIC CONSOLE OUTPUT. ZERO FABRICATED TEST COUNTS.
 * Executes genuine compilers and test runners installed on the developer machine.
 * If the required runtime is unavailable, records:
 * "NOT EXECUTED — Required runtime unavailable"
 */

const ALLOWED_EXECUTABLES = new Set(['dotnet', 'mvn', 'npm']);
const DEFAULT_TIMEOUT_MS = 60000; // 60 seconds

/**
 * Checks whether an executable exists on the system PATH
 * @param {string} executableName 
 * @returns {boolean}
 */
function isExecutableAvailable(executableName) {
    if (!ALLOWED_EXECUTABLES.has(executableName)) {
        return false;
    }
    try {
        const cmd = process.platform === 'win32' ? `where ${executableName}` : `which ${executableName}`;
        execSync(cmd, { stdio: 'ignore', timeout: 3000 });
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Detects the appropriate test runner for a given finding and repository
 * @param {object} finding 
 * @param {string} repoFullPath 
 * @returns {{ tool: string, args: string[] } | null}
 */
function detectRunner(finding, repoFullPath) {
    const tech = (finding?.Technology || '').toLowerCase();

    // 1. Check technology declaration
    if (tech === 'dotnet' || tech === 'csharp' || tech === '.net') {
        return { tool: 'dotnet', args: ['test', '--nologo', '-v', 'normal'] };
    }
    if (tech === 'java' || tech === 'java-spring') {
        return { tool: 'mvn', args: ['test', '-B'] };
    }
    if (tech === 'javascript' || tech === 'typescript' || tech === 'node') {
        return { tool: 'npm', args: ['test', '--', '--watchAll=false'] };
    }

    // 2. Inspect repository files on disk if repo path exists
    if (repoFullPath && fs.existsSync(repoFullPath)) {
        if (fs.existsSync(path.join(repoFullPath, 'pom.xml'))) {
            return { tool: 'mvn', args: ['test', '-B'] };
        }
        if (fs.existsSync(path.join(repoFullPath, 'package.json'))) {
            return { tool: 'npm', args: ['test'] };
        }
        try {
            const files = fs.readdirSync(repoFullPath);
            if (files.some(f => f.endsWith('.sln') || f.endsWith('.csproj'))) {
                return { tool: 'dotnet', args: ['test', '--nologo', '-v', 'normal'] };
            }
        } catch (e) {}
    }

    // Default fallback based on finding technology
    return { tool: 'dotnet', args: ['test', '--nologo', '-v', 'normal'] };
}

/**
 * Parses test output for dotnet test
 */
function parseDotnetOutput(stdout, stderr, exitCode) {
    const combined = stdout + '\n' + stderr;
    let testsPassed = 0;
    let testsFailed = 0;
    let testsSkipped = 0;
    let testsTotal = 0;

    const totalMatch = combined.match(/Total tests:\s*(\d+)/i) || combined.match(/Total:\s*(\d+)/i);
    const passedMatch = combined.match(/Passed:\s*(\d+)/i);
    const failedMatch = combined.match(/Failed:\s*(\d+)/i);
    const skippedMatch = combined.match(/Skipped:\s*(\d+)/i);

    if (passedMatch) testsPassed = parseInt(passedMatch[1], 10);
    if (failedMatch) testsFailed = parseInt(failedMatch[1], 10);
    if (skippedMatch) testsSkipped = parseInt(skippedMatch[1], 10);

    if (totalMatch) {
        testsTotal = parseInt(totalMatch[1], 10);
    } else {
        testsTotal = testsPassed + testsFailed + testsSkipped;
    }

    const compilationFailed = /Build FAILED/i.test(combined) || /CS\d{4}:/i.test(combined);

    let status = 'PASS';
    if (compilationFailed || exitCode !== 0 || testsFailed > 0) {
        status = 'FAIL';
    }

    return {
        status,
        testsPassed,
        testsFailed,
        testsSkipped,
        testsTotal,
        compilationFailed
    };
}

/**
 * Parses test output for Maven (mvn test)
 */
function parseMavenOutput(stdout, stderr, exitCode) {
    const combined = stdout + '\n' + stderr;
    let testsPassed = 0;
    let testsFailed = 0;
    let testsErrors = 0;
    let testsSkipped = 0;
    let testsTotal = 0;

    const summaryMatch = combined.match(/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/i);
    if (summaryMatch) {
        testsTotal = parseInt(summaryMatch[1], 10);
        testsFailed = parseInt(summaryMatch[2], 10);
        testsErrors = parseInt(summaryMatch[3], 10);
        testsSkipped = parseInt(summaryMatch[4], 10);
        testsPassed = Math.max(0, testsTotal - testsFailed - testsErrors - testsSkipped);
    }

    const buildFailure = /BUILD FAILURE/i.test(combined);
    const compilationFailed = /Compilation failure/i.test(combined) || /\[ERROR\] COMPILATION ERROR/i.test(combined);

    let status = 'PASS';
    if (buildFailure || compilationFailed || exitCode !== 0 || testsFailed > 0 || testsErrors > 0) {
        status = 'FAIL';
    }

    return {
        status,
        testsPassed,
        testsFailed: testsFailed + testsErrors,
        testsSkipped,
        testsTotal,
        compilationFailed
    };
}

/**
 * Parses test output for npm test
 */
function parseNpmOutput(stdout, stderr, exitCode) {
    const combined = stdout + '\n' + stderr;
    let testsPassed = 0;
    let testsFailed = 0;
    let testsTotal = 0;

    const passMatch = combined.match(/Tests:\s*(\d+)\s*passed/i);
    const failMatch = combined.match(/Tests:\s*(\d+)\s*failed/i);
    const totalMatch = combined.match(/Tests:\s*(\d+)\s*total/i);

    if (passMatch) testsPassed = parseInt(passMatch[1], 10);
    if (failMatch) testsFailed = parseInt(failMatch[1], 10);
    if (totalMatch) testsTotal = parseInt(totalMatch[1], 10);
    else testsTotal = testsPassed + testsFailed;

    const status = (exitCode === 0 && testsFailed === 0) ? 'PASS' : 'FAIL';
    return {
        status,
        testsPassed,
        testsFailed,
        testsSkipped: 0,
        testsTotal,
        compilationFailed: exitCode !== 0 && testsTotal === 0
    };
}

/**
 * Redacts common sensitive information patterns from console outputs
 */
function redactSensitiveOutput(text) {
    if (!text) return '';
    return text
        .replace(/(?:api[_-]?key|secret|password|token|bearer\s+)["':= ]+([A-Za-z0-9_-]{12,})/gi, 'REDACTED_SECRET')
        .replace(/(?:ghp_[A-Za-z0-9]{36})/g, 'ghp_REDACTED');
}

/**
 * Safely executes a genuine test command in the repository workspace
 * @param {string} executable Allowlisted executable ('dotnet', 'mvn', 'npm')
 * @param {string[]} args Command arguments
 * @param {string} cwd Working directory
 * @param {object} options Optional execution parameters { timeoutMs, cancellationToken }
 * @returns {Promise<object>} Structured execution result
 */
function executeRealTestRunner(executable, args, cwd, options = {}) {
    return new Promise((resolve) => {
        const startTime = new Date();
        const startTimeIso = startTime.toISOString();

        // 1. Enforce executable allowlist
        if (!ALLOWED_EXECUTABLES.has(executable)) {
            const endTime = new Date();
            resolve({
                executed: false,
                status: 'NOT EXECUTED',
                reason: `Unauthorized test runner executable: '${executable}'`,
                executable,
                command: `${executable} ${args.join(' ')}`,
                workingDirectory: cwd,
                startTime: startTimeIso,
                endTime: endTime.toISOString(),
                durationMs: 0,
                exitCode: null,
                testsTotal: 0,
                testsPassed: 0,
                testsFailed: 0,
                stdout: '',
                stderr: `Executable '${executable}' is not in the approved security allowlist.`,
                summary: `NOT EXECUTED — Unauthorized executable '${executable}'`
            });
            return;
        }

        // 2. Check executable availability on system PATH
        if (!isExecutableAvailable(executable)) {
            const endTime = new Date();
            resolve({
                executed: false,
                status: 'NOT EXECUTED',
                reason: 'Required runtime unavailable',
                executable,
                command: `${executable} ${args.join(' ')}`,
                workingDirectory: cwd,
                startTime: startTimeIso,
                endTime: endTime.toISOString(),
                durationMs: 0,
                exitCode: null,
                testsTotal: 0,
                testsPassed: 0,
                testsFailed: 0,
                stdout: '',
                stderr: `NOT EXECUTED — Required runtime unavailable: '${executable}' not found in system PATH.`,
                summary: `NOT EXECUTED — Required runtime unavailable: '${executable}' not found in PATH.`
            });
            return;
        }

        // 3. Verify working directory exists
        if (!cwd || !fs.existsSync(cwd)) {
            const endTime = new Date();
            resolve({
                executed: false,
                status: 'NOT EXECUTED',
                reason: 'Working directory not found',
                executable,
                command: `${executable} ${args.join(' ')}`,
                workingDirectory: cwd,
                startTime: startTimeIso,
                endTime: endTime.toISOString(),
                durationMs: 0,
                exitCode: null,
                testsTotal: 0,
                testsPassed: 0,
                testsFailed: 0,
                stdout: '',
                stderr: `Working directory does not exist on disk: '${cwd}'`,
                summary: `NOT EXECUTED — Working directory not found: ${cwd}`
            });
            return;
        }

        // 4. Execute safely without shell interpolation
        const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
        let stdout = '';
        let stderr = '';
        let killed = false;

        let child;
        try {
            child = spawn(executable, args, {
                cwd,
                env: { ...process.env, CI: 'true', DOTNET_CLI_TELEMETRY_OPTOUT: '1' },
                stdio: ['ignore', 'pipe', 'pipe']
            });
        } catch (err) {
            const endTime = new Date();
            resolve({
                executed: false,
                status: 'NOT EXECUTED',
                reason: `Process spawn error: ${err.message}`,
                executable,
                command: `${executable} ${args.join(' ')}`,
                workingDirectory: cwd,
                startTime: startTimeIso,
                endTime: endTime.toISOString(),
                durationMs: 0,
                exitCode: null,
                testsTotal: 0,
                testsPassed: 0,
                testsFailed: 0,
                stdout: '',
                stderr: err.message,
                summary: `NOT EXECUTED — Failed to spawn ${executable}: ${err.message}`
            });
            return;
        }

        const timer = setTimeout(() => {
            killed = true;
            try { child.kill('SIGTERM'); } catch (e) {}
        }, timeoutMs);

        const MAX_OUTPUT = 256 * 1024; // 256 KB max per stream to avoid buffer overflow

        child.stdout.on('data', (chunk) => {
            if (stdout.length < MAX_OUTPUT) stdout += chunk.toString();
        });

        child.stderr.on('data', (chunk) => {
            if (stderr.length < MAX_OUTPUT) stderr += chunk.toString();
        });

        child.on('error', (err) => {
            clearTimeout(timer);
            const endTime = new Date();
            resolve({
                executed: false,
                status: 'NOT EXECUTED',
                reason: `Execution failed: ${err.message}`,
                executable,
                command: `${executable} ${args.join(' ')}`,
                workingDirectory: cwd,
                startTime: startTimeIso,
                endTime: endTime.toISOString(),
                durationMs: endTime - startTime,
                exitCode: null,
                testsTotal: 0,
                testsPassed: 0,
                testsFailed: 0,
                stdout: redactSensitiveOutput(stdout),
                stderr: redactSensitiveOutput(stderr || err.message),
                summary: `NOT EXECUTED — Execution error: ${err.message}`
            });
        });

        child.on('close', (code) => {
            clearTimeout(timer);
            const endTime = new Date();
            const durationMs = endTime - startTime;

            if (killed) {
                resolve({
                    executed: true,
                    status: 'FAIL',
                    reason: `Execution timed out after ${timeoutMs}ms`,
                    executable,
                    command: `${executable} ${args.join(' ')}`,
                    workingDirectory: cwd,
                    startTime: startTimeIso,
                    endTime: endTime.toISOString(),
                    durationMs,
                    exitCode: code,
                    testsTotal: 0,
                    testsPassed: 0,
                    testsFailed: 1,
                    stdout: redactSensitiveOutput(stdout),
                    stderr: `Execution timed out after ${timeoutMs}ms`,
                    summary: `FAIL — Execution timed out after ${timeoutMs}ms`
                });
                return;
            }

            // Parse test counts and pass/fail status
            let parsed = { status: code === 0 ? 'PASS' : 'FAIL', testsPassed: 0, testsFailed: 0, testsTotal: 0 };
            if (executable === 'dotnet') {
                parsed = parseDotnetOutput(stdout, stderr, code);
            } else if (executable === 'mvn') {
                parsed = parseMavenOutput(stdout, stderr, code);
            } else if (executable === 'npm') {
                parsed = parseNpmOutput(stdout, stderr, code);
            }

            const cleanOut = redactSensitiveOutput(stdout);
            const cleanErr = redactSensitiveOutput(stderr);

            const summary = parsed.status === 'PASS'
                ? `PASS — Tests passed (${parsed.testsPassed}/${parsed.testsTotal || parsed.testsPassed || 1}), Exit Code: ${code}`
                : `FAIL — Test run failed (Passed: ${parsed.testsPassed}, Failed: ${parsed.testsFailed}), Exit Code: ${code}`;

            resolve({
                executed: true,
                status: parsed.status,
                reason: parsed.status === 'PASS' ? 'All assertions passed' : (parsed.compilationFailed ? 'Compilation failed' : 'Test assertions failed'),
                executable,
                command: `${executable} ${args.join(' ')}`,
                workingDirectory: cwd,
                startTime: startTimeIso,
                endTime: endTime.toISOString(),
                durationMs,
                exitCode: code,
                testsTotal: parsed.testsTotal,
                testsPassed: parsed.testsPassed,
                testsFailed: parsed.testsFailed,
                stdout: cleanOut,
                stderr: cleanErr,
                consoleOutput: (cleanOut + (cleanErr ? '\n' + cleanErr : '')).trim(),
                summary
            });
        });
    });
}

/**
 * Runs genuine baseline tests on the target repository before code changes are applied
 * @param {object} finding Finding from vulnerabilities.csv
 * @param {string} workspaceRoot Workspace root directory
 * @returns {Promise<object>} Baseline test results
 */
async function runBaselineTests(finding, workspaceRoot) {
    const repoRel = finding.Repository || '';
    const repoFull = repoRel ? path.join(workspaceRoot, repoRel) : workspaceRoot;
    const runner = detectRunner(finding, repoFull);

    if (!runner) {
        return {
            executed: false,
            status: 'NOT EXECUTED',
            reason: 'No compatible test runner detected',
            summary: 'NOT EXECUTED — No test runner detected for technology ' + (finding.Technology || 'unknown')
        };
    }

    return await executeRealTestRunner(runner.tool, runner.args, repoFull);
}

/**
 * Runs genuine post-fix tests on the target repository after code changes are applied
 * @param {object} finding Finding from vulnerabilities.csv
 * @param {string} workspaceRoot Workspace root directory
 * @returns {Promise<object>} Post-fix test results
 */
async function runPostFixTests(finding, workspaceRoot) {
    const repoRel = finding.Repository || '';
    const repoFull = repoRel ? path.join(workspaceRoot, repoRel) : workspaceRoot;
    const runner = detectRunner(finding, repoFull);

    if (!runner) {
        return {
            executed: false,
            status: 'NOT EXECUTED',
            reason: 'No compatible test runner detected',
            summary: 'NOT EXECUTED — No test runner detected for technology ' + (finding.Technology || 'unknown')
        };
    }

    return await executeRealTestRunner(runner.tool, runner.args, repoFull);
}

module.exports = {
    isExecutableAvailable,
    detectRunner,
    executeRealTestRunner,
    runBaselineTests,
    runPostFixTests
};
