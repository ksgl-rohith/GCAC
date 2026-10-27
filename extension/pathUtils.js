const path = require('path');
const fs = require('fs');

/**
 * Validates that a candidate file path is strictly within the allowed workspace boundary.
 * Prevents directory traversal attacks (../, absolute paths outside workspace, symlink escapes).
 * 
 * @param {string} candidatePath Path supplied by webview, scanner, or user input
 * @param {string} workspaceRoot Allowed workspace root directory
 * @returns {string|null} Canonical absolute path if valid and contained, null if rejected
 */
function assertPathWithinWorkspace(candidatePath, workspaceRoot) {
    if (!candidatePath || typeof candidatePath !== 'string' || !workspaceRoot) {
        return null;
    }

    const resolvedWs = path.resolve(workspaceRoot);
    const resolvedPath = path.isAbsolute(candidatePath)
        ? path.resolve(candidatePath)
        : path.resolve(resolvedWs, candidatePath);

    // Relative containment check
    const rel = path.relative(resolvedWs, resolvedPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return null;
    }

    // Check realpath if file/dir exists to guard against symlink escapes
    try {
        if (fs.existsSync(resolvedPath)) {
            const realPath = fs.realpathSync(resolvedPath);
            let realWs = resolvedWs;
            try { realWs = fs.realpathSync(resolvedWs); } catch (e) {}
            const realRel = path.relative(realWs, realPath);
            if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
                return null;
            }
            return realPath;
        }
    } catch (e) {
        return null;
    }

    return resolvedPath;
}

module.exports = {
    assertPathWithinWorkspace
};
