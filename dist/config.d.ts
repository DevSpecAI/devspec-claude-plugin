import type { AutopilotSettings, AutopilotState, CycleResult } from './types.js';
export declare function getGlobalConfigDir(): string;
export declare function getLogsDir(): string;
export declare function getTaskLogPath(taskId: string): string;
export declare function getAutopilotState(): AutopilotState | null;
export declare function initAutopilotState(projectId: string, settings: AutopilotSettings): AutopilotState;
export declare function updateCycleResult(result: CycleResult): void;
export declare function stopAutopilot(): void;
export declare function isAutopilotRunning(): boolean;
export declare function parseAutopilotSettings(raw: unknown): AutopilotSettings;
export declare function ensureGlobalConfigDir(): Promise<void>;
//# sourceMappingURL=config.d.ts.map