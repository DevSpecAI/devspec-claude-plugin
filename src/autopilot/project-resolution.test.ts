import { describe, it, expect } from 'vitest';
import { resolveProjectFromRemoteMatch } from './loop.js';
import {
  buildResolveProjectArgs,
  buildFetchNextWorkArgs,
  buildFetchByActivityArgs,
  buildGetProjectSummaryArgs,
  buildSearchMemoriesArgs,
  buildFetchPlanningArgs,
  buildFetchStagedArgs,
} from '../mcp/client.js';

// ---------------------------------------------------------------------------
// Account-wide token: resolve the run's project from list_projects' remote_match
// ---------------------------------------------------------------------------

describe('resolveProjectFromRemoteMatch', () => {
  const remote = 'github.com/acme/widget';

  it('uses resolved_project_id when the remote maps to exactly one project', () => {
    const res = resolveProjectFromRemoteMatch(
      { resolved_project_id: 'proj-123', candidate_project_ids: [] },
      remote,
    );
    expect(res.projectId).toBe('proj-123');
    expect(res.ambiguous).toBe(false);
    expect(res.error).toBeNull();
  });

  it('flags ambiguity (never guesses) when the repo is tracked by multiple projects', () => {
    const res = resolveProjectFromRemoteMatch(
      { resolved_project_id: null, candidate_project_ids: ['proj-a', 'proj-b'] },
      remote,
    );
    expect(res.projectId).toBeNull();
    expect(res.ambiguous).toBe(true);
    expect(res.candidates).toEqual(['proj-a', 'proj-b']);
    // The error must name the candidates so the operator can pick one.
    expect(res.error).toContain('proj-a');
    expect(res.error).toContain('proj-b');
    expect(res.error).toContain('--project-id');
  });

  it('errors clearly when no project tracks the repo', () => {
    const res = resolveProjectFromRemoteMatch(
      { resolved_project_id: null, candidate_project_ids: [] },
      remote,
    );
    expect(res.projectId).toBeNull();
    expect(res.ambiguous).toBe(false);
    expect(res.error).toContain('No DevSpec project');
    expect(res.error).toContain(remote);
  });

  it('treats a missing remote_match as a no-match error', () => {
    const res = resolveProjectFromRemoteMatch(null, remote);
    expect(res.projectId).toBeNull();
    expect(res.error).toContain('No DevSpec project');
  });
});

// ---------------------------------------------------------------------------
// Project-scoped arg builders thread project_id
// ---------------------------------------------------------------------------

describe('project-scoped arg builders include project_id', () => {
  const projectId = 'proj-123';

  it('buildResolveProjectArgs passes git_remote', () => {
    expect(buildResolveProjectArgs({ gitRemote: 'github.com/acme/widget' })).toEqual({
      git_remote: 'github.com/acme/widget',
    });
  });

  it('buildFetchNextWorkArgs', () => {
    expect(buildFetchNextWorkArgs({ projectId })).toEqual({ project_id: projectId });
  });

  it('buildFetchByActivityArgs', () => {
    expect(buildFetchByActivityArgs({ projectId, agentActivity: 'in_progress' })).toEqual({
      project_id: projectId,
      agent_activity: 'in_progress',
    });
  });

  it('buildGetProjectSummaryArgs', () => {
    expect(buildGetProjectSummaryArgs({ projectId })).toEqual({ project_id: projectId });
  });

  it('buildSearchMemoriesArgs', () => {
    expect(buildSearchMemoriesArgs({ projectId, query: 'auth refactor' })).toEqual({
      project_id: projectId,
      query: 'auth refactor',
    });
  });

  it('buildFetchPlanningArgs', () => {
    expect(buildFetchPlanningArgs({ projectId })).toEqual({
      project_id: projectId,
      agent_activity: 'planning',
    });
  });

  it('buildFetchStagedArgs', () => {
    expect(buildFetchStagedArgs({ agentStatus: 'staged', projectId })).toEqual({
      project_id: projectId,
      agent_ready: true,
      agent_activity: 'staged',
      lifecycle: 'open',
    });
  });
});
