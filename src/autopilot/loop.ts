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

import type { AutopilotSettings, CycleResult, HeartbeatPayload, HeartbeatResponse, RepositoryInfo, RunnerStatus } from '../types.js';
import { isAutopilotRunning, updateCycleResult, getAutopilotState } from '../config.js';
import { collectWorkspaceRepos, refreshRepoBranches } from '../vcs/index.js';

// =============================================================================
// Repository Info Cache
// =============================================================================

let cachedRepos: RepositoryInfo[] | null = null;
let cacheTimestamp = 0;
const REPO_CACHE_TTL_MS = 30_000; // 30 seconds — for the directory scan only

/**
 * Get workspace repositories with up-to-date branch/SHA info.
 *
 * The full directory scan + remote URL lookup is cached (30s TTL) since
 * repos rarely appear/disappear. But branch and SHA are ALWAYS re-read
 * fresh because the user may switch branches in another terminal.
 */
async function getCachedWorkspaceRepos(): Promise<RepositoryInfo[]> {
  const now = Date.now();
  const cwd = process.cwd();

  // Full scan: only when cache is cold or expired
  if (!cachedRepos || now - cacheTimestamp >= REPO_CACHE_TTL_MS) {
    try {
      cachedRepos = await collectWorkspaceRepos(cwd);
      cacheTimestamp = now;
    } catch {
      if (!cachedRepos) cachedRepos = [];
    }
  }

  // Always refresh branch/SHA — these are fast git commands
  try {
    return await refreshRepoBranches(cwd, cachedRepos);
  } catch {
    return cachedRepos;
  }
}

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

// =============================================================================
// Validation Gating (009-runner-repo-guard)
// =============================================================================

let gated = false;
let gateReason: string | null = null;

/**
 * Process the heartbeat response from the server and update the gating flag.
 *
 * If the server reports `branch_mismatch` or `repo_not_found`, the runner is
 * gated and should skip work-claiming until the issue is resolved. When the
 * state is `aligned` or `manual_override`, the gate is cleared.
 */
export function processHeartbeatResponse(response: HeartbeatResponse): void {
  const state = response.validation_state;

  if (state === 'branch_mismatch' || state === 'repo_not_found') {
    gated = true;
    gateReason =
      response.validation_details?.message ??
      `Validation failed: ${state}`;
    console.warn(`[autopilot] Runner gated — ${gateReason}`);
  } else {
    // 'aligned', 'manual_override', or undefined (no validation configured)
    if (gated) {
      console.info('[autopilot] Runner gate cleared — validation passed.');
    }
    gated = false;
    gateReason = null;
  }
}

/**
 * Returns true if the runner is currently gated by a validation failure
 * and should NOT claim new work items.
 */
export function isGated(): boolean {
  return gated;
}

/**
 * Returns the reason the runner is gated, or null if not gated.
 */
export function getGateReason(): string | null {
  return gateReason;
}

/**
 * Reset gating state (e.g. on session start).
 */
export function resetGate(): void {
  gated = false;
  gateReason = null;
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
 * Build a heartbeat payload from the current loop context and cycle result.
 * Used by the skill to call the send_heartbeat MCP tool after each cycle.
 */
export async function buildHeartbeatPayload(
  ctx: LoopContext,
  result: CycleResult,
): Promise<HeartbeatPayload> {
  const state = getAutopilotState();

  // Determine runner status from the cycle result
  let status: RunnerStatus = 'idle';
  if (result.action === 'claimed' || result.action === 'completed' || result.action === 'failed') {
    // If we just claimed, we're working. If completed/failed, back to idle.
    status = result.action === 'claimed' ? 'working' : 'idle';
  }

  // Collect workspace repository info (cached, TTL 30s)
  const repositories = await getCachedWorkspaceRepos();

  const payload: HeartbeatPayload = {
    session_id: state?.sessionId ?? '',
    machine_hostname: state?.machineHostname ?? '',
    status,
    cycle_count: ctx.cycleCount,
    tasks_completed: state?.tasksCompleted ?? 0,
    repositories,
  };

  // Include current task info if working
  if (status === 'working' && result.actionItemId) {
    payload.current_task_id = result.actionItemId;
    payload.current_task_title = result.actionItemTitle;
  }

  // Include last error if the cycle failed
  if (result.action === 'failed' && result.error) {
    payload.last_error = result.error;
  }

  return payload;
}

/**
 * Build a heartbeat payload for startup (status: idle) or shutdown (status: offline).
 */
export async function buildLifecycleHeartbeat(status: 'idle' | 'offline'): Promise<HeartbeatPayload> {
  const state = getAutopilotState();

  // Collect workspace repository info (cached, TTL 30s)
  const repositories = await getCachedWorkspaceRepos();

  return {
    session_id: state?.sessionId ?? '',
    machine_hostname: state?.machineHostname ?? '',
    status,
    cycle_count: state?.cycleCount ?? 0,
    tasks_completed: state?.tasksCompleted ?? 0,
    repositories,
  };
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
