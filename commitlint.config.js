/**
 * Conventional Commits, enforced by the commit-msg hook.
 *
 * Checked rather than remembered: a convention nobody verifies drifts within a month, and the
 * commit log is the one artefact that cannot be reformatted later.
 */
export default { extends: ['@commitlint/config-conventional'] };
