import { z } from 'zod';
export declare const AgentStatusSchema: z.ZodEnum<["planning", "queued", "in_progress", "completed", "failed"]>;
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export declare const ActionItemSchema: z.ZodObject<{
    id: z.ZodString;
    title: z.ZodString;
    description: z.ZodNullable<z.ZodString>;
    status: z.ZodString;
    type: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    priority: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    agent_ready: z.ZodBoolean;
    agent_status: z.ZodNullable<z.ZodEnum<["planning", "queued", "in_progress", "completed", "failed"]>>;
    agent_claimed_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    agent_error: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    agent_branch: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    agent_commit_sha: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    project_id: z.ZodOptional<z.ZodString>;
    created_at: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    status: string;
    id: string;
    title: string;
    description: string | null;
    agent_ready: boolean;
    agent_status: "planning" | "queued" | "in_progress" | "completed" | "failed" | null;
    type?: string | null | undefined;
    priority?: string | null | undefined;
    agent_claimed_at?: string | null | undefined;
    agent_error?: string | null | undefined;
    agent_branch?: string | null | undefined;
    agent_commit_sha?: string | null | undefined;
    project_id?: string | undefined;
    created_at?: string | undefined;
}, {
    status: string;
    id: string;
    title: string;
    description: string | null;
    agent_ready: boolean;
    agent_status: "planning" | "queued" | "in_progress" | "completed" | "failed" | null;
    type?: string | null | undefined;
    priority?: string | null | undefined;
    agent_claimed_at?: string | null | undefined;
    agent_error?: string | null | undefined;
    agent_branch?: string | null | undefined;
    agent_commit_sha?: string | null | undefined;
    project_id?: string | undefined;
    created_at?: string | undefined;
}>;
export type ActionItem = z.infer<typeof ActionItemSchema>;
export declare const AutopilotSettingsSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    target_branch: z.ZodDefault<z.ZodString>;
    auto_push: z.ZodDefault<z.ZodBoolean>;
    auto_merge: z.ZodDefault<z.ZodBoolean>;
    branch_prefix: z.ZodDefault<z.ZodString>;
    commit_message_prefix: z.ZodDefault<z.ZodString>;
    custom_instructions: z.ZodDefault<z.ZodString>;
    test_commands: z.ZodDefault<z.ZodObject<{
        unit: z.ZodDefault<z.ZodString>;
        e2e: z.ZodDefault<z.ZodString>;
        typecheck: z.ZodDefault<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        unit: string;
        e2e: string;
        typecheck: string;
    }, {
        unit?: string | undefined;
        e2e?: string | undefined;
        typecheck?: string | undefined;
    }>>;
    protected_paths: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    idle_detection: z.ZodDefault<z.ZodBoolean>;
    poll_interval_seconds: z.ZodDefault<z.ZodNumber>;
    stale_claim_timeout_minutes: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    enabled: boolean;
    target_branch: string;
    auto_push: boolean;
    auto_merge: boolean;
    branch_prefix: string;
    commit_message_prefix: string;
    custom_instructions: string;
    test_commands: {
        unit: string;
        e2e: string;
        typecheck: string;
    };
    protected_paths: string[];
    idle_detection: boolean;
    poll_interval_seconds: number;
    stale_claim_timeout_minutes: number;
}, {
    enabled?: boolean | undefined;
    target_branch?: string | undefined;
    auto_push?: boolean | undefined;
    auto_merge?: boolean | undefined;
    branch_prefix?: string | undefined;
    commit_message_prefix?: string | undefined;
    custom_instructions?: string | undefined;
    test_commands?: {
        unit?: string | undefined;
        e2e?: string | undefined;
        typecheck?: string | undefined;
    } | undefined;
    protected_paths?: string[] | undefined;
    idle_detection?: boolean | undefined;
    poll_interval_seconds?: number | undefined;
    stale_claim_timeout_minutes?: number | undefined;
}>;
export type AutopilotSettings = z.infer<typeof AutopilotSettingsSchema>;
export declare const DEFAULT_AUTOPILOT_SETTINGS: AutopilotSettings;
export declare const CycleResultSchema: z.ZodObject<{
    action: z.ZodEnum<["idle", "claimed", "completed", "failed", "planning_done", "claim_lost", "mcp_error", "stopped"]>;
    actionItemId: z.ZodOptional<z.ZodString>;
    actionItemTitle: z.ZodOptional<z.ZodString>;
    commitSha: z.ZodOptional<z.ZodString>;
    branchName: z.ZodOptional<z.ZodString>;
    error: z.ZodOptional<z.ZodString>;
    durationMs: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    action: "completed" | "failed" | "idle" | "claimed" | "planning_done" | "claim_lost" | "mcp_error" | "stopped";
    actionItemId?: string | undefined;
    actionItemTitle?: string | undefined;
    commitSha?: string | undefined;
    branchName?: string | undefined;
    error?: string | undefined;
    durationMs?: number | undefined;
}, {
    action: "completed" | "failed" | "idle" | "claimed" | "planning_done" | "claim_lost" | "mcp_error" | "stopped";
    actionItemId?: string | undefined;
    actionItemTitle?: string | undefined;
    commitSha?: string | undefined;
    branchName?: string | undefined;
    error?: string | undefined;
    durationMs?: number | undefined;
}>;
export type CycleResult = z.infer<typeof CycleResultSchema>;
export interface AutopilotState {
    running: boolean;
    projectId: string;
    settings: AutopilotSettings;
    cycleCount: number;
    lastCycleResult: CycleResult | null;
}
export declare const ExecutionStatusSchema: z.ZodEnum<["success", "failure", "timeout", "skipped", "running"]>;
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;
export declare const ExecutionHistoryRecordSchema: z.ZodObject<{
    id: z.ZodString;
    actionItemId: z.ZodOptional<z.ZodString>;
    actionItemTitle: z.ZodOptional<z.ZodString>;
    agentStatus: z.ZodOptional<z.ZodString>;
    project: z.ZodString;
    startedAt: z.ZodString;
    completedAt: z.ZodOptional<z.ZodString>;
    status: z.ZodEnum<["success", "failure", "timeout", "skipped", "running"]>;
    triggeredBy: z.ZodString;
    duration: z.ZodOptional<z.ZodNumber>;
    output: z.ZodOptional<z.ZodString>;
    error: z.ZodOptional<z.ZodString>;
    worktreePath: z.ZodOptional<z.ZodString>;
    worktreeBranch: z.ZodOptional<z.ZodString>;
    worktreePushed: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    status: "success" | "failure" | "timeout" | "skipped" | "running";
    id: string;
    project: string;
    startedAt: string;
    triggeredBy: string;
    actionItemId?: string | undefined;
    actionItemTitle?: string | undefined;
    error?: string | undefined;
    agentStatus?: string | undefined;
    completedAt?: string | undefined;
    duration?: number | undefined;
    output?: string | undefined;
    worktreePath?: string | undefined;
    worktreeBranch?: string | undefined;
    worktreePushed?: boolean | undefined;
}, {
    status: "success" | "failure" | "timeout" | "skipped" | "running";
    id: string;
    project: string;
    startedAt: string;
    triggeredBy: string;
    actionItemId?: string | undefined;
    actionItemTitle?: string | undefined;
    error?: string | undefined;
    agentStatus?: string | undefined;
    completedAt?: string | undefined;
    duration?: number | undefined;
    output?: string | undefined;
    worktreePath?: string | undefined;
    worktreeBranch?: string | undefined;
    worktreePushed?: boolean | undefined;
}>;
export type ExecutionHistoryRecord = z.infer<typeof ExecutionHistoryRecordSchema>;
//# sourceMappingURL=types.d.ts.map