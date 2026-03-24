/**
 * Three-layer prompt architecture for the DevSpec Autopilot.
 *
 * Layer 1: Hardcoded base system prompt (non-user-modifiable)
 * Layer 2: User-defined custom instructions from project settings
 * Layer 3: Action item context from DevSpec MCP
 */
import type { ActionItem, AutopilotSettings } from '../types.js';
/**
 * Build the complete prompt for an autopilot execution cycle.
 */
export declare function buildPrompt(item: ActionItem, settings: AutopilotSettings): string;
/**
 * Build the prompt for planning mode (analysis only, no code changes).
 */
export declare function buildPlanningPrompt(item: ActionItem, settings: AutopilotSettings): string;
//# sourceMappingURL=prompt.d.ts.map