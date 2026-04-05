/**
 * Three-layer prompt architecture for the DevSpec Autopilot.
 *
 * Layer 1: Hardcoded base system prompt (non-user-modifiable)
 * Layer 2: User-defined custom instructions from project settings
 * Layer 3: Action item context from DevSpec MCP
 */

import type { ActionItem, AutopilotSettings } from '../types.js';

// =============================================================================
// Layer 1: Base System Prompt (hardcoded, non-modifiable)
// =============================================================================

const LAYER_1_BASE_PROMPT = `You are the DevSpec Autopilot. Your job is to implement a single action item autonomously.

WORKFLOW:
1. Read and understand the action item description and any linked context
2. Analyze the codebase to understand the relevant code
3. ALWAYS read a file before editing it — never attempt to edit a file you haven't read in this session
4. Implement the required changes
5. Run configured test commands
6. Review your changes for correctness and safety

SAFETY RULES:
- Never ask for user input, confirmation, or clarification — all decisions are autonomous
- Never force-push or push to protected branches
- Never modify files matching protected path patterns
- Document all decisions in your implementation notes
- If the task is too vague, ambiguous, or requires human judgment, STOP and report failure with a clear explanation

QUALITY STANDARDS:
- Follow existing code conventions and patterns
- Write clean, readable code
- Ensure all tests pass before considering the task complete
- If pre-existing test failures exist unrelated to your changes, note them but do not let them block completion`;

// =============================================================================
// Layer 2 & 3 Assembly
// =============================================================================

/**
 * Build the complete prompt for an autopilot execution cycle.
 */
export function buildPrompt(
  item: ActionItem,
  settings: AutopilotSettings,
): string {
  const parts: string[] = [LAYER_1_BASE_PROMPT];

  // Layer 2: Custom instructions from project settings
  if (settings.custom_instructions?.trim()) {
    parts.push(`\n## Project-Specific Instructions\n\n${settings.custom_instructions.trim()}`);
  }

  // Protected paths notice
  if (settings.protected_paths.length > 0) {
    parts.push(`\n## Protected Paths (DO NOT MODIFY)\n\n${settings.protected_paths.map(p => `- ${p}`).join('\n')}`);
  }

  // Test commands
  const testCmds = Object.entries(settings.test_commands)
    .filter(([, cmd]) => cmd?.trim())
    .map(([type, cmd]) => `- ${type}: \`${cmd}\``);
  if (testCmds.length > 0) {
    parts.push(`\n## Test Commands (run after implementation)\n\n${testCmds.join('\n')}`);
  }

  // Layer 3: Action item context
  parts.push(`\n## Action Item\n`);
  parts.push(`**Title**: ${item.title}`);
  parts.push(`**ID**: ${item.id}`);
  if (item.type) parts.push(`**Type**: ${item.type}`);
  if (item.priority) parts.push(`**Priority**: ${item.priority}`);
  if (item.description) parts.push(`\n**Description**:\n${item.description}`);

  return parts.join('\n');
}

/**
 * Build the prompt for planning mode (analysis only, no code changes).
 */
export function buildPlanningPrompt(
  item: ActionItem,
  settings: AutopilotSettings,
): string {
  const parts: string[] = [
    `You are the DevSpec Autopilot in PLANNING MODE. Your job is to analyze this action item and write a proposed implementation plan. Do NOT make any code changes, create branches, or commit.

WORKFLOW:
1. Read and understand the action item
2. Analyze the relevant codebase
3. Write a detailed implementation plan covering:
   - Which files need to be modified or created
   - What changes are needed in each file
   - Any risks or edge cases to consider
   - Estimated complexity
4. Output the plan as an implementation note

IMPORTANT: This is analysis only. Do NOT modify any files.`,
  ];

  // Layer 2: Custom instructions
  if (settings.custom_instructions?.trim()) {
    parts.push(`\n## Project-Specific Instructions\n\n${settings.custom_instructions.trim()}`);
  }

  // Layer 3: Action item context
  parts.push(`\n## Action Item to Analyze\n`);
  parts.push(`**Title**: ${item.title}`);
  parts.push(`**ID**: ${item.id}`);
  if (item.type) parts.push(`**Type**: ${item.type}`);
  if (item.priority) parts.push(`**Priority**: ${item.priority}`);
  if (item.description) parts.push(`\n**Description**:\n${item.description}`);

  return parts.join('\n');
}

/**
 * Build the prompt for review mode (read-only analysis, structured feedback).
 */
export function buildReviewPrompt(
  item: ActionItem,
  settings: AutopilotSettings,
): string {
  const parts: string[] = [
    `You are the DevSpec Autopilot in REVIEW MODE. Your job is to critically review a plan written by the team and provide structured feedback. You do NOT implement anything — you review and report.

WORKFLOW:
1. Read the action item description — this IS the plan to review
2. Call get_session_transcript with the source session ID to read the full conversation that produced this plan
3. Read ALL codebase files relevant to the plan. Be thorough — this is a review, not a skim
4. Produce honest, specific feedback. Not generic. Not optimistic. Name real risks and gaps
5. Call submit_plan_review with your structured output

WHAT TO LOOK FOR:
- Does the plan account for all affected files and their current state?
- Are there missing edge cases, error handling gaps, or race conditions?
- Does it conflict with existing patterns or conventions in the codebase?
- Are the database changes safe and reversible?
- Will the proposed changes break any existing functionality?
- Are there simpler alternatives the team may not have considered?

OUTPUT RULES:
- Every recommendation MUST reference a specific file, function, or design decision
- Every question MUST name what it blocks (e.g., "Blocks: migration design" not just "What about X?")
- The summary must state whether the plan is sound overall and identify the single biggest risk
- Do NOT rewrite the plan — that is DevSpec's job. Your job is to validate, flag risks, and identify gaps

CRITICAL: Do NOT make any code changes. Do NOT create branches or commits. This is review-only.`,
  ];

  // Layer 2: Custom instructions
  if (settings.custom_instructions?.trim()) {
    parts.push(`\n## Project-Specific Instructions\n\n${settings.custom_instructions.trim()}`);
  }

  // Layer 3: Action item context
  parts.push(`\n## Plan to Review\n`);
  parts.push(`**Title**: ${item.title}`);
  parts.push(`**ID**: ${item.id}`);
  if (item.type) parts.push(`**Type**: ${item.type}`);
  if (item.priority) parts.push(`**Priority**: ${item.priority}`);
  if (item.description) parts.push(`\n**Plan (from action item description)**:\n${item.description}`);

  return parts.join('\n');
}
