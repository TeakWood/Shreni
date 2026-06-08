import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync } from 'fs';
import { resolve, join } from 'path';
import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';
import type { KshetraConfig } from '../kshetra/config.js';
import { bd } from '../sthapathi/beads.js';
import { git } from '../sthapathi/git.js';
import { loadState } from '../kshetra/state.js';

const execFileAsync = promisify(execFile);

export const VICHARA_TOOLS: Tool[] = [
  {
    name: 'get_bead',
    description: 'Get full details of a specific bead by ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        kshetra_id: { type: 'string', description: 'Kshetra ID' },
        id: { type: 'string', description: 'Bead ID' },
      },
      required: ['kshetra_id', 'id'],
    },
  },
  {
    name: 'list_beads',
    description: 'List beads with optional status filter.',
    input_schema: {
      type: 'object' as const,
      properties: {
        kshetra_id: { type: 'string', description: 'Kshetra ID' },
        status: {
          type: 'string',
          description: 'Filter by status: open, in_progress, closed, blocked',
        },
      },
      required: ['kshetra_id'],
    },
  },
  {
    name: 'get_agent_status',
    description: 'Get live Sthapathi agent and Kshetra state.',
    input_schema: {
      type: 'object' as const,
      properties: {
        kshetra_id: { type: 'string', description: 'Kshetra ID' },
      },
      required: ['kshetra_id'],
    },
  },
  {
    name: 'search_codebase',
    description: 'Search the codebase for a pattern using grep.',
    input_schema: {
      type: 'object' as const,
      properties: {
        kshetra_id: { type: 'string', description: 'Kshetra ID' },
        query: { type: 'string', description: 'Search pattern (grep-compatible)' },
      },
      required: ['kshetra_id', 'query'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file from the Kshetra repository (scoped to repo root).',
    input_schema: {
      type: 'object' as const,
      properties: {
        kshetra_id: { type: 'string', description: 'Kshetra ID' },
        path: { type: 'string', description: 'Relative path within the repository' },
      },
      required: ['kshetra_id', 'path'],
    },
  },
  {
    name: 'get_diff',
    description: 'Get unified git diff for a branch against main.',
    input_schema: {
      type: 'object' as const,
      properties: {
        kshetra_id: { type: 'string', description: 'Kshetra ID' },
        branch: { type: 'string', description: 'Branch name' },
      },
      required: ['kshetra_id', 'branch'],
    },
  },
];

function findKshetra(id: string, kshetras: KshetraConfig[]): KshetraConfig | null {
  return kshetras.find(k => k.id === id) ?? null;
}

export async function executeTool(
  name: string,
  input: Record<string, string>,
  kshetras: KshetraConfig[],
): Promise<string> {
  const kshetraId = input['kshetra_id'] ?? '';
  const kshetra = findKshetra(kshetraId, kshetras);

  if (!kshetra) {
    return `Error: kshetra '${kshetraId}' not found. Available: ${kshetras.map(k => k.id).join(', ')}`;
  }

  switch (name) {
    case 'get_bead': {
      const beadId = input['id'] ?? '';
      return bd(kshetra).show(beadId).catch((e: Error) => `Error: ${e.message}`);
    }

    case 'list_beads': {
      const status = input['status'];
      return bd(kshetra).list(status ? { status } : {}).catch((e: Error) => `Error: ${e.message}`);
    }

    case 'get_agent_status': {
      const state = loadState();
      const ks = state.kshetras[kshetra.id] ?? {};
      return JSON.stringify(
        { kshetraId: kshetra.id, paused: (ks as { paused?: boolean }).paused ?? false, reason: (ks as { reason?: string }).reason, message: (ks as { message?: string }).message },
        null,
        2,
      );
    }

    case 'search_codebase': {
      const query = input['query'] ?? '';
      try {
        const { stdout } = await execFileAsync(
          'grep',
          ['-rn', '--include=*.ts', '--include=*.js', '--include=*.py', '-l', query, kshetra.repo.path],
          { maxBuffer: 2 * 1024 * 1024 },
        );
        return stdout.trim() || '(no matches)';
      } catch {
        return '(no matches)';
      }
    }

    case 'read_file': {
      const relPath = input['path'] ?? '';
      const safePath = resolve(join(kshetra.repo.path, relPath));
      if (!safePath.startsWith(kshetra.repo.path + '/') && safePath !== kshetra.repo.path) {
        return 'Error: path is outside the kshetra repository';
      }
      try {
        const content = readFileSync(safePath, 'utf8');
        return content.length > 32000 ? content.slice(0, 32000) + '\n... (truncated)' : content;
      } catch (e) {
        return `Error: ${(e as Error).message}`;
      }
    }

    case 'get_diff': {
      const branch = input['branch'] ?? '';
      return git(kshetra).branchDiff(branch).catch((e: Error) => `Error: ${e.message}`);
    }

    default:
      return `Error: unknown tool '${name}'`;
  }
}