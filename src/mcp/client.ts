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

// =============================================================================
// MCP Operation Descriptors
// =============================================================================

/**
 * Describes the MCP call to fetch planning action items.
 * Claude executes: get_action_items({ agent_activity: 'planning' })
 *
 * For staged items, use get_next_work_item() instead — it returns a single
 * item with full context, avoiding the 90k+ char overflow that
 * get_action_items({ agent_activity: 'staged' }) causes
 * when many items are staged.
 */
export interface FetchPlanningItemsParams {
  agentActivity: 'planning';
}

/**
 * Describes the MCP call to atomically claim a staged action item.
 * Claude executes: claim_work_item({ action_item_id, agent_branch })
 * Transitions staged → in_progress. Fails if item is no longer staged.
 */
export interface ClaimItemParams {
  actionItemId: string;
  agentBranch: string;
}

/**
 * Describes the MCP call to report success.
 * Claude executes: update_action_item({ action_item_id, agent_activity: 'completed', commit_sha })
 */
export interface ReportSuccessParams {
  actionItemId: string;
  commitSha: string;
  lifecycle?: 'done';
}

/**
 * Describes the MCP call to report failure.
 * Claude executes: update_action_item({ action_item_id, agent_activity: 'failed', agent_error })
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
 * Claude executes: get_project_summary({ project_id })
 * Returns project info including autopilot settings.
 */
export interface ProjectSummary {
  id: string;
  name: string;
  autopilot: AutopilotSettings | null;
}

/**
 * Describes the startup project-resolution call for account-wide MCP tokens.
 *
 * Account-wide tokens no longer pin a project — the server resolves the project
 * per call from the most-specific id (an item id self-locates; else an explicit
 * `project_id`; else the caller's single project; else it errors). So the runner
 * must resolve WHICH project to operate on at startup and thread `project_id` on
 * every project-scoped call.
 *
 * Claude executes: list_projects({ git_remote: "<git remote get-url origin>" })
 * The response carries `remote_match: { resolved_project_id, candidate_project_ids }`:
 *   - `resolved_project_id` non-null → use it as the run's project.
 *   - null + `candidate_project_ids` (repo tracked by >1 project) → ambiguous;
 *     unattended autopilot must STOP and fail naming the candidates (never guess).
 *     Interactive commands ask the user instead.
 *   - no match → fail with a clear "no DevSpec project for this repo" error.
 */
export interface ResolveProjectParams {
  /** Output of `git remote get-url origin` for the workspace's primary repo. */
  gitRemote: string;
}

export interface RemoteMatch {
  resolved_project_id: string | null;
  candidate_project_ids: string[];
}

export function buildResolveProjectArgs(params: ResolveProjectParams) {
  return {
    git_remote: params.gitRemote,
  };
}

// =============================================================================
// Helper: Build MCP tool call args
// =============================================================================

/**
 * Build args for the staged-work fetch.
 * Claude executes: get_next_work_item({ project_id, ... })
 *
 * Account-wide tokens require `project_id` on project-scoped calls — pass the
 * project resolved at startup (AutopilotState.projectId).
 */
export function buildFetchNextWorkArgs(params: { projectId: string }) {
  return {
    project_id: params.projectId,
  };
}

export function buildFetchPlanningArgs(params: { projectId: string }) {
  return {
    project_id: params.projectId,
    agent_activity: 'planning',
  };
}

/** @deprecated Use get_next_work_item() MCP tool instead — avoids bulk-fetching all staged items */
export function buildFetchStagedArgs(params: { agentStatus: 'staged' | 'planning'; projectId: string }) {
  return {
    project_id: params.projectId,
    agent_activity: params.agentStatus,
    lifecycle: 'open',
  };
}

/**
 * Build args for the agent-activity fetch used by stale-claim / planning checks.
 * Claude executes: get_action_items({ project_id, agent_activity })
 */
export function buildFetchByActivityArgs(params: {
  projectId: string;
  agentActivity: string;
}) {
  return {
    project_id: params.projectId,
    agent_activity: params.agentActivity,
  };
}

/**
 * Build args for project settings fetch.
 * Claude executes: get_project_summary({ project_id })
 */
export function buildGetProjectSummaryArgs(params: { projectId: string }) {
  return {
    project_id: params.projectId,
  };
}

/**
 * Build args for the memory grounding search.
 * Claude executes: search_memories({ project_id, query })
 */
export function buildSearchMemoriesArgs(params: { projectId: string; query: string }) {
  return {
    project_id: params.projectId,
    query: params.query,
  };
}

export function buildClaimArgs(params: ClaimItemParams) {
  return {
    action_item_id: params.actionItemId,
    agent_branch: params.agentBranch,
  };
}

export function buildReportSuccessArgs(params: ReportSuccessParams) {
  return {
    action_item_id: params.actionItemId,
    agent_activity: 'completed',
    commit_sha: params.commitSha,
    lifecycle: params.lifecycle ?? 'done',
  };
}

export function buildReportFailureArgs(params: ReportFailureParams) {
  return {
    action_item_id: params.actionItemId,
    agent_activity: 'failed',
    agent_error: params.agentError,
  };
}

export function buildAddNoteArgs(params: AddImplementationNoteParams) {
  return {
    content: params.content,
    action_item_id: params.actionItemId,
  };
}

export function buildAddCommitRefArgs(params: AddCommitReferenceParams) {
  return {
    commit_sha: params.commitSha,
    commit_message: params.commitMessage,
    action_item_id: params.actionItemId,
  };
}

/**
 * Generates the branch name for an action item based on config.
 */
export function generateBranchName(actionItemId: string, branchPrefix: string): string {
  const shortId = actionItemId.slice(0, 8);
  return `${branchPrefix}${shortId}`;
}

/**
 * Describes the stale claim detection flow.
 * Claude executes:
 * 1. get_action_items({ agent_activity: 'in_progress' }) — one of the three parallel fetch calls
 * 2. For each item where agent_claimed_at is older than timeoutMinutes:
 *    update_action_item({ action_item_id, agent_activity: 'failed', agent_error: 'Stale claim: process may have crashed' })
 */
export interface DetectStaleClaimsParams {
  timeoutMinutes: number;
}

/**
 * Check if a claimed_at timestamp is stale given the timeout.
 */
export function isStaleClaimAt(claimedAt: string | null | undefined, timeoutMinutes: number): boolean {
  if (!claimedAt) return false;
  const claimTime = new Date(claimedAt).getTime();
  const thresholdMs = timeoutMinutes * 60 * 1000;
  return Date.now() - claimTime > thresholdMs;
}

export function buildStaleFailArgs(actionItemId: string) {
  return {
    action_item_id: actionItemId,
    agent_activity: 'failed',
    agent_error: 'Stale claim: process may have crashed',
  };
}
