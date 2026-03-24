/**
 * Autopilot Polling Loop
 *
 * This module defines the polling loop structure that the skill/command
 * instructs Claude to follow. The actual polling happens within a Claude Code
 * session — this module provides the loop logic and state management.
 *
 * The skill SKILL.md references this loop structure and instructs Claude to:
 * 1. Call get_action_items to check for queued/planning items
 * 2. If found, claim and process one item per cycle
 * 3. Wait poll_interval_seconds
 * 4. Repeat until stopped
 */

import type { AutopilotSettings, CycleResult } from '../types.js';
import { isAutopilotRunning, updateCycleResult } from '../config.js';

// =============================================================================
// Loop State
// =============================================================================

export interface LoopContext {
  settings: AutopilotSettings;
  cycleCount: number;
  startedAt: Date;
}

/**
 * Create a new loop context.
 */
export function createLoopContext(settings: AutopilotSettings): LoopContext {
  return {
    settings,
    cycleCount: 0,
    startedAt: new Date(),
  };
}

/**
 * Record a cycle result and increment the counter.
 */
export function recordCycle(ctx: LoopContext, result: CycleResult): void {
  ctx.cycleCount++;
  updateCycleResult(result);
}

/**
 * Check if the loop should continue.
 */
export function shouldContinue(): boolean {
  return isAutopilotRunning();
}

/**
 * Format a cycle result for display to the user.
 */
export function formatCycleResult(result: CycleResult, cycleNumber: number): string {
  const prefix = `[Cycle ${cycleNumber}]`;

  switch (result.action) {
    case 'idle':
      return `${prefix} No queued items found. Waiting for next cycle.`;
    case 'claimed':
      return `${prefix} Claimed: "${result.actionItemTitle}" (${result.actionItemId})`;
    case 'completed':
      return `${prefix} Completed: "${result.actionItemTitle}" → ${result.branchName} (${result.commitSha?.slice(0, 8)}) in ${formatDuration(result.durationMs)}`;
    case 'failed':
      return `${prefix} Failed: "${result.actionItemTitle}" — ${result.error}`;
    case 'planning_done':
      return `${prefix} Planning complete: "${result.actionItemTitle}" — proposed plan written as implementation note. Awaiting human review.`;
    case 'claim_lost':
      return `${prefix} Claim lost: "${result.actionItemTitle}" was claimed by another instance.`;
    case 'mcp_error':
      return `${prefix} MCP error: ${result.error}. Will retry next cycle.`;
    case 'stopped':
      return `${prefix} Autopilot stopped.`;
    default:
      return `${prefix} Unknown action: ${result.action}`;
  }
}

function formatDuration(ms?: number): string {
  if (!ms) return 'unknown duration';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

/**
 * Format the autopilot status summary.
 */
export function formatStatus(ctx: LoopContext, running: boolean): string {
  const uptime = Date.now() - ctx.startedAt.getTime();
  const lines = [
    `**Autopilot Status**: ${running ? 'Running' : 'Stopped'}`,
    `**Cycles completed**: ${ctx.cycleCount}`,
    `**Uptime**: ${formatDuration(uptime)}`,
    `**Poll interval**: ${ctx.settings.poll_interval_seconds}s`,
    `**Target branch**: ${ctx.settings.target_branch}`,
    `**Auto-push**: ${ctx.settings.auto_push}`,
    `**Auto-merge**: ${ctx.settings.auto_merge}`,
    `**Idle detection**: ${ctx.settings.idle_detection ? 'on' : 'off'}`,
  ];
  return lines.join('\n');
}
