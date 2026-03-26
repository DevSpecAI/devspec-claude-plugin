import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('fs-extra', () => ({
  default: {
    readdir: vi.fn(),
    pathExists: vi.fn(),
    stat: vi.fn(),
  },
  readdir: vi.fn(),
  pathExists: vi.fn(),
  stat: vi.fn(),
}));

import { normalizeRepoUrl, collectWorkspaceRepos } from './index.js';
import { execa } from 'execa';
import * as fs from 'fs-extra';

const mockedExeca = vi.mocked(execa);
const mockedFs = vi.mocked(fs);

// ---------------------------------------------------------------------------
// normalizeRepoUrl
// ---------------------------------------------------------------------------

describe('normalizeRepoUrl', () => {
  it('normalizes SSH shorthand format', () => {
    expect(normalizeRepoUrl('git@github.com:org/repo.git')).toBe(
      'github.com/org/repo',
    );
  });

  it('normalizes HTTPS format', () => {
    expect(normalizeRepoUrl('https://github.com/org/repo')).toBe(
      'github.com/org/repo',
    );
  });

  it('strips trailing .git from HTTPS URLs', () => {
    expect(normalizeRepoUrl('https://github.com/org/repo.git')).toBe(
      'github.com/org/repo',
    );
  });

  it('strips embedded credentials from HTTPS URLs', () => {
    expect(
      normalizeRepoUrl('https://user:token@github.com/org/repo.git'),
    ).toBe('github.com/org/repo');
  });

  it('lowercases the host portion only', () => {
    expect(normalizeRepoUrl('git@GitHub.COM:Org/Repo.git')).toBe(
      'github.com/Org/Repo',
    );
  });

  it('strips trailing slashes', () => {
    expect(normalizeRepoUrl('https://github.com/org/repo/')).toBe(
      'github.com/org/repo',
    );
  });

  it('trims whitespace', () => {
    expect(normalizeRepoUrl('  https://github.com/org/repo  ')).toBe(
      'github.com/org/repo',
    );
  });
});

// ---------------------------------------------------------------------------
// collectWorkspaceRepos
// ---------------------------------------------------------------------------

describe('collectWorkspaceRepos', () => {
  const ROOT = '/workspace/project';

  beforeEach(() => {
    vi.resetAllMocks();
  });

  /**
   * Helper: configure execa mock to respond to specific git commands
   * executed in a given cwd.
   */
  function mockGitForRepo(
    repoPath: string,
    opts: {
      remoteUrl?: string;
      branch?: string;
      sha?: string;
      remoteError?: boolean;
    },
  ) {
    mockedExeca.mockImplementation(((_cmd: string, args: string[], execOpts: { cwd: string }) => {
      if (execOpts?.cwd !== repoPath) {
        // Fall through to a default rejection so unrelated calls don't hang
        return Promise.reject(new Error(`unexpected execa call in ${execOpts?.cwd}`));
      }

      const joined = args.join(' ');

      if (joined.includes('remote get-url origin')) {
        if (opts.remoteError) {
          return Promise.reject(new Error('fatal: no such remote'));
        }
        return Promise.resolve({ stdout: opts.remoteUrl ?? '' });
      }

      if (joined.includes('branch --show-current')) {
        return Promise.resolve({ stdout: opts.branch ?? '' });
      }

      if (joined.includes('rev-parse --short HEAD')) {
        return Promise.resolve({ stdout: opts.sha ?? 'abc1234' });
      }

      return Promise.reject(new Error(`unhandled git command: ${joined}`));
    }) as any);
  }

  /**
   * Helper: builds an execa mock that dispatches based on cwd, supporting
   * multiple repos at once.
   */
  function mockGitForMultipleRepos(
    repos: Array<{
      path: string;
      remoteUrl?: string;
      branch?: string;
      sha?: string;
      remoteError?: boolean;
    }>,
  ) {
    mockedExeca.mockImplementation(((_cmd: string, args: string[], execOpts: { cwd: string }) => {
      const repo = repos.find((r) => r.path === execOpts?.cwd);
      if (!repo) {
        return Promise.reject(new Error(`unexpected execa call in ${execOpts?.cwd}`));
      }

      const joined = args.join(' ');

      if (joined.includes('remote get-url origin')) {
        if (repo.remoteError) {
          return Promise.reject(new Error('fatal: no such remote'));
        }
        return Promise.resolve({ stdout: repo.remoteUrl ?? '' });
      }

      if (joined.includes('branch --show-current')) {
        return Promise.resolve({ stdout: repo.branch ?? '' });
      }

      if (joined.includes('rev-parse --short HEAD')) {
        return Promise.resolve({ stdout: repo.sha ?? 'abc1234' });
      }

      return Promise.reject(new Error(`unhandled git command: ${joined}`));
    }) as any);
  }

  it('returns one RepositoryInfo for a single root repo with a remote', async () => {
    // Root repo has a remote, branch, and SHA
    mockGitForRepo(ROOT, {
      remoteUrl: 'git@github.com:org/project.git',
      branch: 'main',
      sha: 'f00cafe',
    });

    // No child directories
    mockedFs.readdir.mockResolvedValue([] as any);

    const repos = await collectWorkspaceRepos(ROOT);

    expect(repos).toHaveLength(1);
    expect(repos[0]).toEqual({
      name: 'project',
      remote_url: 'git@github.com:org/project.git',
      normalized_url: 'github.com/org/project',
      branch: 'main',
      detached: false,
      short_sha: 'f00cafe',
    });
  });

  it('skips repos with no remote (returns empty)', async () => {
    mockGitForRepo(ROOT, { remoteError: true });

    mockedFs.readdir.mockResolvedValue([] as any);

    const repos = await collectWorkspaceRepos(ROOT);

    expect(repos).toHaveLength(0);
  });

  it('detects detached HEAD when branch output is empty', async () => {
    mockGitForRepo(ROOT, {
      remoteUrl: 'https://github.com/org/project.git',
      branch: '', // empty → detached
      sha: 'deadbeef',
    });

    mockedFs.readdir.mockResolvedValue([] as any);

    const repos = await collectWorkspaceRepos(ROOT);

    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({
      branch: null,
      detached: true,
      short_sha: 'deadbeef',
    });
  });

  it('excludes worktree directories where .git is a file', async () => {
    // Root repo
    const childPath = path.join(ROOT, 'child-worktree');
    const childGitPath = path.join(childPath, '.git');

    mockGitForMultipleRepos([
      {
        path: ROOT,
        remoteUrl: 'git@github.com:org/project.git',
        branch: 'main',
        sha: 'aaa1111',
      },
    ]);

    // readdir returns one child directory
    mockedFs.readdir.mockResolvedValue([
      { name: 'child-worktree', isDirectory: () => true },
    ] as any);

    // .git exists at the child path
    mockedFs.pathExists.mockImplementation(((p: string) => {
      if (p === childGitPath) return Promise.resolve(true);
      return Promise.resolve(false);
    }) as any);

    // .git at child is a FILE (worktree pointer), not a directory
    mockedFs.stat.mockImplementation(((p: string) => {
      if (p === childGitPath) {
        return Promise.resolve({ isFile: () => true, isDirectory: () => false });
      }
      return Promise.resolve({ isFile: () => false, isDirectory: () => true });
    }) as any);

    const repos = await collectWorkspaceRepos(ROOT);

    // Only the root repo should be returned; the child worktree is excluded
    expect(repos).toHaveLength(1);
    expect(repos[0].name).toBe('project');
  });

  it('excludes directories under the worktreeBasePath', async () => {
    const worktreeBase = path.join(ROOT, '.worktrees');

    mockGitForMultipleRepos([
      {
        path: ROOT,
        remoteUrl: 'git@github.com:org/project.git',
        branch: 'main',
        sha: 'bbb2222',
      },
    ]);

    // readdir returns the worktree base directory as a child
    mockedFs.readdir.mockResolvedValue([
      { name: '.worktrees', isDirectory: () => true },
    ] as any);

    const repos = await collectWorkspaceRepos(ROOT, worktreeBase);

    // Root repo only — .worktrees child should be skipped via startsWith check
    expect(repos).toHaveLength(1);
    expect(repos[0].name).toBe('project');
  });

  it('includes a valid child git repo alongside the root', async () => {
    const childPath = path.join(ROOT, 'subproject');
    const childGitPath = path.join(childPath, '.git');

    mockGitForMultipleRepos([
      {
        path: ROOT,
        remoteUrl: 'git@github.com:org/project.git',
        branch: 'main',
        sha: 'aaa1111',
      },
      {
        path: childPath,
        remoteUrl: 'git@github.com:org/subproject.git',
        branch: 'dev',
        sha: 'bbb2222',
      },
    ]);

    mockedFs.readdir.mockResolvedValue([
      { name: 'subproject', isDirectory: () => true },
    ] as any);

    mockedFs.pathExists.mockImplementation(((p: string) => {
      if (p === childGitPath) return Promise.resolve(true);
      return Promise.resolve(false);
    }) as any);

    // .git at child is a real directory (not a worktree file)
    mockedFs.stat.mockImplementation(((p: string) => {
      if (p === childGitPath) {
        return Promise.resolve({ isFile: () => false, isDirectory: () => true });
      }
      return Promise.resolve({ isFile: () => false, isDirectory: () => true });
    }) as any);

    const repos = await collectWorkspaceRepos(ROOT);

    expect(repos).toHaveLength(2);
    expect(repos[0].name).toBe('project');
    expect(repos[1]).toEqual({
      name: 'subproject',
      remote_url: 'git@github.com:org/subproject.git',
      normalized_url: 'github.com/org/subproject',
      branch: 'dev',
      detached: false,
      short_sha: 'bbb2222',
    });
  });
});
