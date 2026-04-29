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
 * For queued items, use get_next_work_item() instead — it returns a single
 * item with full context, avoiding the 90k+ char overflow that
 * get_action_items({ agent_ready: true, agent_activity: 'queued' }) causes
 * when many items are in the queue.
 */
export interface FetchPlanningItemsParams {
  agentActivity: 'planning';
}

/**
 * Describes the MCP call to atomically claim a queued action item.
 * Claude executes: claim_work_item({ action_item_id, agent_branch })
 * Transitions queued → in_progress. Fails if item is no longer queued.
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
 * Claude executes: get_project_summary()
 * Returns project info including autopilot settings.
 */
export interface ProjectSummary {
  id: string;
  name: string;
  autopilot: AutopilotSettings | null;
}

// =============================================================================
// Helper: Build MCP tool call args
// =============================================================================

export function buildFetchPlanningArgs() {
  return {
    agent_activity: 'planning',
  };
}

/** @deprecated Use get_next_work_item() MCP tool instead — avoids bulk-fetching all queued items */
export function buildFetchQueuedArgs(params: { agentStatus: 'queued' | 'planning' }) {
  return {
    agent_ready: true,
    agent_activity: params.agentStatus,
    lifecycle: 'open',
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
