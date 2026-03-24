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
import type { AutopilotSettings } from '../types.js';
/**
 * Describes the MCP call to fetch queued/planning action items.
 * Claude executes: get_action_items({ agent_ready: true, agent_status: 'queued' })
 */
export interface FetchQueuedItemsParams {
    agentStatus: 'queued' | 'planning';
}
/**
 * Describes the MCP call to claim an action item.
 * Claude executes: update_action_item({ action_item_id, agent_status: 'in_progress', agent_branch })
 */
export interface ClaimItemParams {
    actionItemId: string;
    agentBranch: string;
}
/**
 * Describes the MCP call to report success.
 * Claude executes: update_action_item({ action_item_id, agent_status: 'completed', commit_sha })
 */
export interface ReportSuccessParams {
    actionItemId: string;
    commitSha: string;
    status?: 'done';
}
/**
 * Describes the MCP call to report failure.
 * Claude executes: update_action_item({ action_item_id, agent_status: 'failed', agent_error })
 */
export interface ReportFailureParams {
    actionItemId: string;
    agentError: string;
}
/**
 * Describes the MCP call to add an implementation note.
 * Claude executes: add_implementation_note({ content, action_item_id })
 */
export interface AddImplementationNoteParams {
    content: string;
    actionItemId?: string;
}
/**
 * Describes the MCP call to add a commit reference.
 * Claude executes: add_commit_reference({ commit_sha, commit_message, action_item_id })
 */
export interface AddCommitReferenceParams {
    commitSha: string;
    commitMessage?: string;
    actionItemId?: string;
}
/**
 * Describes the MCP call to fetch project settings.
 * Claude executes: get_project_summary()
 * Returns project info including autopilot settings.
 */
export interface ProjectSummary {
    id: string;
    name: string;
    autopilot: AutopilotSettings | null;
}
export declare function buildFetchQueuedArgs(params: FetchQueuedItemsParams): {
    agent_ready: boolean;
    agent_status: "planning" | "queued";
    status: string;
};
export declare function buildClaimArgs(params: ClaimItemParams): {
    action_item_id: string;
    agent_status: string;
    agent_branch: string;
};
export declare function buildReportSuccessArgs(params: ReportSuccessParams): {
    action_item_id: string;
    agent_status: string;
    commit_sha: string;
    status: "done";
};
export declare function buildReportFailureArgs(params: ReportFailureParams): {
    action_item_id: string;
    agent_status: string;
    agent_error: string;
};
export declare function buildAddNoteArgs(params: AddImplementationNoteParams): {
    content: string;
    action_item_id: string | undefined;
};
export declare function buildAddCommitRefArgs(params: AddCommitReferenceParams): {
    commit_sha: string;
    commit_message: string | undefined;
    action_item_id: string | undefined;
};
/**
 * Generates the branch name for an action item based on config.
 */
export declare function generateBranchName(actionItemId: string, branchPrefix: string): string;
/**
 * Describes the stale claim detection flow.
 * Claude executes:
 * 1. get_action_items({ agent_status: 'in_progress' })
 * 2. For each item where agent_claimed_at is older than timeoutMinutes:
 *    update_action_item({ action_item_id, agent_status: 'failed', agent_error: 'Stale claim: process may have crashed' })
 */
export interface DetectStaleClaimsParams {
    timeoutMinutes: number;
}
/**
 * Check if a claimed_at timestamp is stale given the timeout.
 */
export declare function isStaleClaimAt(claimedAt: string | null | undefined, timeoutMinutes: number): boolean;
export declare function buildStaleFailArgs(actionItemId: string): {
    action_item_id: string;
    agent_status: string;
    agent_error: string;
};
//# sourceMappingURL=client.d.ts.map