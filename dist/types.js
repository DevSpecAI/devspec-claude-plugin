import { z } from 'zod';
// =============================================================================
// Agent Status
// =============================================================================
export const AgentStatusSchema = z.enum([
    'planning',
    'queued',
    'in_progress',
    'completed',
    'failed',
]);
// =============================================================================
// Action Item (from DevSpec MCP)
// =============================================================================
export const ActionItemSchema = z.object({
    id: z.string().uuid(),
    title: z.string(),
    description: z.string().nullable(),
    status: z.string(),
    type: z.string().nullable().optional(),
    priority: z.string().nullable().optional(),
    agent_ready: z.boolean(),
    agent_status: AgentStatusSchema.nullable(),
    agent_claimed_at: z.string().nullable().optional(),
    agent_error: z.string().nullable().optional(),
    agent_branch: z.string().nullable().optional(),
    agent_commit_sha: z.string().nullable().optional(),
    project_id: z.string().uuid().optional(),
    created_at: z.string().optional(),
});
// =============================================================================
// Autopilot Configuration (from DevSpec project settings)
// =============================================================================
export const AutopilotSettingsSchema = z.object({
    enabled: z.boolean().default(false),
    target_branch: z.string().default('staging'),
    auto_push: z.boolean().default(true),
    auto_merge: z.boolean().default(true),
    branch_prefix: z.string().default('fix/action-item-'),
    commit_message_prefix: z.string().default('[autopilot] '),
    custom_instructions: z.string().default(''),
    test_commands: z.object({
        unit: z.string().default(''),
        e2e: z.string().default(''),
        typecheck: z.string().default(''),
    }).default({}),
    protected_paths: z.array(z.string()).default([]),
    idle_detection: z.boolean().default(false),
    poll_interval_seconds: z.number().positive().default(60),
    stale_claim_timeout_minutes: z.number().positive().default(30),
});
export const DEFAULT_AUTOPILOT_SETTINGS = AutopilotSettingsSchema.parse({});
// =============================================================================
// Autopilot Cycle Result
// =============================================================================
export const CycleResultSchema = z.object({
    action: z.enum(['idle', 'claimed', 'completed', 'failed', 'planning_done', 'claim_lost', 'mcp_error', 'stopped']),
    actionItemId: z.string().optional(),
    actionItemTitle: z.string().optional(),
    commitSha: z.string().optional(),
    branchName: z.string().optional(),
    error: z.string().optional(),
    durationMs: z.number().optional(),
});
// =============================================================================
// Execution History (adapted from scheduler)
// =============================================================================
export const ExecutionStatusSchema = z.enum([
    'success',
    'failure',
    'timeout',
    'skipped',
    'running',
]);
export const ExecutionHistoryRecordSchema = z.object({
    id: z.string().uuid(),
    actionItemId: z.string().optional(),
    actionItemTitle: z.string().optional(),
    agentStatus: z.string().optional(),
    project: z.string(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    status: ExecutionStatusSchema,
    triggeredBy: z.string(),
    duration: z.number().optional(),
    output: z.string().optional(),
    error: z.string().optional(),
    worktreePath: z.string().optional(),
    worktreeBranch: z.string().optional(),
    worktreePushed: z.boolean().optional(),
});
//# sourceMappingURL=types.js.map