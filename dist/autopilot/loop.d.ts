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
export interface LoopContext {
    settings: AutopilotSettings;
    cycleCount: number;
    startedAt: Date;
}
/**
 * Create a new loop context.
 */
export declare function createLoopContext(settings: AutopilotSettings): LoopContext;
/**
 * Record a cycle result and increment the counter.
 */
export declare function recordCycle(ctx: LoopContext, result: CycleResult): void;
/**
 * Check if the loop should continue.
 */
export declare function shouldContinue(): boolean;
/**
 * Format a cycle result for display to the user.
 */
export declare function formatCycleResult(result: CycleResult, cycleNumber: number): string;
/**
 * Format the autopilot status summary.
 */
export declare function formatStatus(ctx: LoopContext, running: boolean): string;
//# sourceMappingURL=loop.d.ts.map