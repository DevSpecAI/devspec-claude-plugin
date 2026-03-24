/**
 * Autopilot Execution Orchestrator
 *
 * Orchestrates the full lifecycle of processing a single action item:
 * - Full execution: worktree → implement → test → commit → push → merge → report
 * - Planning mode: analyze → write implementation note → stop
 *
 * This module defines the orchestration logic. The actual implementation work
 * is done by Claude through the skill prompt. This module provides the structure
 * and type-safe interfaces for the orchestration steps.
 */

import type { ActionItem, AutopilotSettings, CycleResult } from '../types.js';
import { buildPrompt, buildPlanningPrompt } from './prompt.js';
import { generateBranchName } from '../mcp/client.js';

// =============================================================================
// Execution Orchestrator
// =============================================================================

/**
 * Execute a full action item: worktree → implement → test → commit → push → report.
 *
 * This function is called from the skill context where Claude has access to
 * MCP tools and can perform git operations via the worktree module.
 *
 * Returns a CycleResult describing the outcome.
 */
export function prepareExecution(
  item: ActionItem,
  settings: AutopilotSettings,
): {
  prompt: string;
  branchName: string;
  commitMessagePrefix: string;
  testCommands: string[];
  protectedPaths: string[];
  targetBranch: string;
  autoPush: boolean;
  autoMerge: boolean;
} {
  const branchName = generateBranchName(item.id, settings.branch_prefix);
  const prompt = buildPrompt(item, settings);

  const testCommands = Object.values(settings.test_commands).filter(cmd => cmd?.trim());

  return {
    prompt,
    branchName,
    commitMessagePrefix: settings.commit_message_prefix,
    testCommands,
    protectedPaths: settings.protected_paths,
    targetBranch: settings.target_branch,
    autoPush: settings.auto_push,
    autoMerge: settings.auto_merge,
  };
}

/**
 * Prepare a planning-mode execution: analyze → write plan → stop.
 * No worktree, no code changes, no commits.
 */
export function preparePlanningExecution(
  item: ActionItem,
  settings: AutopilotSettings,
): {
  prompt: string;
} {
  const prompt = buildPlanningPrompt(item, settings);
  return { prompt };
}

/**
 * Create a successful cycle result.
 */
export function createSuccessResult(
  item: ActionItem,
  commitSha: string,
  branchName: string,
  durationMs: number,
): CycleResult {
  return {
    action: 'completed',
    actionItemId: item.id,
    actionItemTitle: item.title,
    commitSha,
    branchName,
    durationMs,
  };
}

/**
 * Create a failed cycle result.
 */
export function createFailureResult(
  item: ActionItem,
  error: string,
  durationMs: number,
): CycleResult {
  return {
    action: 'failed',
    actionItemId: item.id,
    actionItemTitle: item.title,
    error,
    durationMs,
  };
}

/**
 * Create a planning-done cycle result.
 */
export function createPlanningDoneResult(
  item: ActionItem,
  durationMs: number,
): CycleResult {
  return {
    action: 'planning_done',
    actionItemId: item.id,
    actionItemTitle: item.title,
    durationMs,
  };
}

/**
 * Create an idle cycle result (no items found).
 */
export function createIdleResult(): CycleResult {
  return { action: 'idle' };
}

/**
 * Create a claim-lost cycle result (race condition).
 */
export function createClaimLostResult(item: ActionItem): CycleResult {
  return {
    action: 'claim_lost',
    actionItemId: item.id,
    actionItemTitle: item.title,
  };
}

/**
 * Create an MCP error cycle result.
 */
export function createMcpErrorResult(error: string): CycleResult {
  return {
    action: 'mcp_error',
    error,
  };
}
