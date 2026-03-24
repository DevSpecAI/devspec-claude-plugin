/**
 * DevSpec MCP Client Wrapper
 *
 * These functions are designed to be called from within a Claude Code skill/command
 * context where MCP tools are available. They define the interface — the actual MCP
 * tool calls are made by Claude through the skill prompt instructions.
 *
 * This module provides type-safe descriptions of MCP operations the autopilot needs.
 * The skill SKILL.md instructs Claude to use the DevSpec MCP tools directly.
 */
// =============================================================================
// Helper: Build MCP tool call args
// =============================================================================
export function buildFetchQueuedArgs(params) {
    return {
        agent_ready: true,
        agent_status: params.agentStatus,
        status: 'open',
    };
}
export function buildClaimArgs(params) {
    return {
        action_item_id: params.actionItemId,
        agent_status: 'in_progress',
        agent_branch: params.agentBranch,
    };
}
export function buildReportSuccessArgs(params) {
    return {
        action_item_id: params.actionItemId,
        agent_status: 'completed',
        commit_sha: params.commitSha,
        status: params.status ?? 'done',
    };
}
export function buildReportFailureArgs(params) {
    return {
        action_item_id: params.actionItemId,
        agent_status: 'failed',
        agent_error: params.agentError,
    };
}
export function buildAddNoteArgs(params) {
    return {
        content: params.content,
        action_item_id: params.actionItemId,
    };
}
export function buildAddCommitRefArgs(params) {
    return {
        commit_sha: params.commitSha,
        commit_message: params.commitMessage,
        action_item_id: params.actionItemId,
    };
}
/**
 * Generates the branch name for an action item based on config.
 */
export function generateBranchName(actionItemId, branchPrefix) {
    const shortId = actionItemId.slice(0, 8);
    return `${branchPrefix}${shortId}`;
}
/**
 * Check if a claimed_at timestamp is stale given the timeout.
 */
export function isStaleClaimAt(claimedAt, timeoutMinutes) {
    if (!claimedAt)
        return false;
    const claimTime = new Date(claimedAt).getTime();
    const thresholdMs = timeoutMinutes * 60 * 1000;
    return Date.now() - claimTime > thresholdMs;
}
export function buildStaleFailArgs(actionItemId) {
    return {
        action_item_id: actionItemId,
        agent_status: 'failed',
        agent_error: 'Stale claim: process may have crashed',
    };
}
//# sourceMappingURL=client.js.map