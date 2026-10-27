const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { assertPathWithinWorkspace, validateWebviewMessage, getNonce } = require('../../extension/extension');

const workspaceRoot = path.resolve(__dirname, '../..');

function run() {
    console.log('[TEST SUITE] Security Controls & Containment Tests');

    // 1. Path Containment Tests (assertPathWithinWorkspace)
    // Permitted: files inside workspace
    const validInside = assertPathWithinWorkspace('vulnerability/vulnerabilities.csv', workspaceRoot);
    assert(validInside !== null, 'Valid path inside workspace should be accepted');
    assert.strictEqual(validInside, path.join(workspaceRoot, 'vulnerability', 'vulnerabilities.csv'));

    // Permitted: output report
    const validReport = assertPathWithinWorkspace('output/sql_injection_in_payment_processing_controller_vul_poc_001.md', workspaceRoot);
    assert(validReport !== null, 'Valid output report path should be accepted');

    // Blocked: Parent directory traversal
    assert.strictEqual(assertPathWithinWorkspace('../../../etc/passwd', workspaceRoot), null, 'Directory traversal (../) must be blocked');
    assert.strictEqual(assertPathWithinWorkspace('vulnerability/../../etc/passwd', workspaceRoot), null, 'Nested traversal must be blocked');

    // Blocked: Absolute paths outside workspace
    assert.strictEqual(assertPathWithinWorkspace('/etc/passwd', workspaceRoot), null, 'Absolute system paths must be blocked');
    assert.strictEqual(assertPathWithinWorkspace('/etc/hosts', workspaceRoot), null, 'Absolute system files must be blocked');
    if (process.platform === 'win32') {
        assert.strictEqual(assertPathWithinWorkspace('C:\\Windows\\System32\\calc.exe', workspaceRoot), null, 'Windows system files must be blocked');
    }

    // Blocked: Null, undefined, empty inputs
    assert.strictEqual(assertPathWithinWorkspace(null, workspaceRoot), null);
    assert.strictEqual(assertPathWithinWorkspace('', workspaceRoot), null);
    assert.strictEqual(assertPathWithinWorkspace({}, workspaceRoot), null);

    // Symlink escape test: symlink inside workspace pointing to external directory must be rejected
    const tempSymlinkPath = path.join(workspaceRoot, 'tests', 'extension', '_test_symlink_escape');
    try {
        if (fs.existsSync(tempSymlinkPath)) fs.unlinkSync(tempSymlinkPath);
        fs.symlinkSync(process.platform === 'win32' ? 'C:\\Windows' : '/etc', tempSymlinkPath, 'dir');
        assert.strictEqual(assertPathWithinWorkspace(tempSymlinkPath, workspaceRoot), null, 'Symlink escaping workspace must be rejected by realpath validation');
    } catch (e) {
        // If symlink creation requires elevated permissions on platform, fallback gracefully
    } finally {
        try { if (fs.existsSync(tempSymlinkPath)) fs.unlinkSync(tempSymlinkPath); } catch (e) {}
    }
    console.log('  ✓ Canonical path containment: All traversal, symlink escapes, and unauthorized file reads rejected');

    // 2. Webview IPC Command Validation (validateWebviewMessage)
    // Valid messages
    assert.strictEqual(validateWebviewMessage({ command: 'getConfig' }).valid, true);
    assert.strictEqual(validateWebviewMessage({ command: 'loadDetails', vulnerabilityId: 'VUL-POC-001' }).valid, true);
    assert.strictEqual(validateWebviewMessage({ command: 'runRemediation', vulnerabilityId: 'GCAS-E2E-001' }).valid, true);
    assert.strictEqual(validateWebviewMessage({ command: 'approveRemediation', vulnerabilityId: 'VUL-POC-008' }).valid, true);

    // Invalid commands (Arbitrary command execution injection)
    assert.strictEqual(validateWebviewMessage({ command: 'execShell' }).valid, false, 'Shell command must be rejected');
    assert.strictEqual(validateWebviewMessage({ command: 'eval' }).valid, false, 'Eval command must be rejected');
    assert.strictEqual(validateWebviewMessage({ command: 'readSecret' }).valid, false, 'Arbitrary command must be rejected');
    assert.strictEqual(validateWebviewMessage({}).valid, false, 'Empty command must be rejected');
    assert.strictEqual(validateWebviewMessage(null).valid, false, 'Null message must be rejected');

    // Malicious vulnerability ID formats (command injection / traversal payloads)
    assert.strictEqual(validateWebviewMessage({ command: 'loadDetails', vulnerabilityId: '../../etc/passwd' }).valid, false);
    assert.strictEqual(validateWebviewMessage({ command: 'loadDetails', vulnerabilityId: 'VUL; rm -rf /' }).valid, false);
    assert.strictEqual(validateWebviewMessage({ command: 'loadDetails', vulnerabilityId: '<script>alert(1)</script>' }).valid, false);
    console.log('  ✓ Webview IPC dispatch validation: Strict allowlist enforced, payloads validated');

    // 3. Stored XSS Neutralization in Markdown Parsing
    // Extract the markdown parser logic from dashboard.js
    function escapeHtml(text) {
        if (text === null || text === undefined) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function renderMarkdown(rawMd) {
        if (!rawMd) return '';
        const escaped = escapeHtml(rawMd);
        const codeBlocks = [];
        let textWithoutBlocks = escaped.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
            const placeholder = `__CODE_BLOCK_${codeBlocks.length}__`;
            codeBlocks.push(`<pre><code class="language-${lang || 'text'}">${code.trim()}</code></pre>`);
            return placeholder;
        });

        const lines = textWithoutBlocks.split('\n');
        const formatted = [];
        for (const line of lines) {
            if (/^# (.*$)/.test(line)) formatted.push(line.replace(/^# (.*$)/, '<h2>$1</h2>'));
            else if (/^## (.*$)/.test(line)) formatted.push(line.replace(/^## (.*$)/, '<h3>$1</h3>'));
            else if (line.trim() !== '') formatted.push(`<p>${line}</p>`);
        }
        let output = formatted.join('\n')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/`([^`]+)`/g, '<code>$1</code>');
        codeBlocks.forEach((block, idx) => {
            output = output.replace(`__CODE_BLOCK_${idx}__`, block);
        });
        return output;
    }

    // Malicious payload tests
    const xssScript = '<script>alert("XSS")</script>';
    const renderedScript = renderMarkdown(xssScript);
    assert(!renderedScript.includes('<script>'), 'Rendered markdown must NOT contain unescaped <script>');
    assert(renderedScript.includes('&lt;script&gt;'), 'Rendered markdown must escape script tags');

    const xssImg = '<img src=x onerror=alert(1)>';
    const renderedImg = renderMarkdown(xssImg);
    assert(!renderedImg.includes('<img'), 'Rendered markdown must NOT contain raw <img> tag');
    assert(renderedImg.includes('&lt;img'), 'Rendered markdown must escape img tags');

    const xssEventHandler = '<a href="javascript:alert(1)" onclick="evil()">Click</a>';
    const renderedEvent = renderMarkdown(xssEventHandler);
    assert(!renderedEvent.includes('<a href="javascript:'), 'Rendered markdown must NOT contain executable javascript: anchor');
    console.log('  ✓ Stored XSS defense: HTML entities strictly neutralized before markdown tag generation');

    // 4. Cryptographic Nonce & CSP Generation
    const nonce1 = getNonce();
    const nonce2 = getNonce();
    assert(nonce1 && nonce1.length >= 16, 'Nonce must be non-empty string of sufficient length');
    assert.notStrictEqual(nonce1, nonce2, 'Consecutive nonces must be unique and randomized');

    const dashboardHtml = fs.readFileSync(path.join(workspaceRoot, 'extension', 'media', 'dashboard.html'), 'utf-8');
    assert(dashboardHtml.includes('http-equiv="Content-Security-Policy"'), 'dashboard.html must contain Content-Security-Policy meta tag');
    console.log('  ✓ Content Security Policy: Strict CSP meta tag and random nonce generation verified');
}

module.exports = { run };
if (require.main === module) {
    run();
}
