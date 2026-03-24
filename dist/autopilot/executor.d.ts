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
/**
 * Execute a full action item: worktree → implement → test → commit → push → report.
 *
 * This function is called from the skill context where Claude has access to
 * MCP tools and can perform git operations via the worktree module.
 *
 * Returns a CycleResult describing the outcome.
 */
export declare function prepareExecution(item: ActionItem, settings: AutopilotSettings): {
    prompt: string;
    branchName: string;
    commitMessagePrefix: string;
    testCommands: string[];
    protectedPaths: string[];
    targetBranch: string;
    autoPush: boolean;
    autoMerge: boolean;
};
/**
 * Prepare a planning-mode execution: analyze → write plan → stop.
 * No worktree, no code changes, no commits.
 */
export declare function preparePlanningExecution(item: ActionItem, settings: AutopilotSettings): {
    prompt: string;
};
/**
 * Create a successful cycle result.
 */
export declare function createSuccessResult(item: ActionItem, commitSha: string, branchName: string, durationMs: number): CycleResult;
/**
 * Create a failed cycle result.
 */
export declare function createFailureResult(item: ActionItem, error: string, durationMs: number): CycleResult;
/**
 * Create a planning-done cycle result.
 */
export declare function createPlanningDoneResult(item: ActionItem, durationMs: number): CycleResult;
/**
 * Create an idle cycle result (no items found).
 */
export declare function createIdleResult(): CycleResult;
/**
 * Create a claim-lost cycle result (race condition).
 */
export declare function createClaimLostResult(item: ActionItem): CycleResult;
/**
 * Create an MCP error cycle result.
 */
export declare function createMcpErrorResult(error: string): CycleResult;
//# sourceMappingURL=executor.d.ts.map