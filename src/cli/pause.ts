import { loadRegistry } from '../kshetra/registry';
import { pauseKshetra, resumeKshetra } from '../kshetra/state';

export type PauseResult =
  | { status: 'paused'; id: string }
  | { status: 'not_found'; id: string };

export type ResumeResult =
  | { status: 'resumed'; id: string }
  | { status: 'not_found'; id: string };

export function pauseKshetraById(id: string): PauseResult {
  const kshetra = loadRegistry().find(k => k.id === id);
  if (!kshetra) return { status: 'not_found', id };

  pauseKshetra(kshetra, {
    manual: true,
    reason: 'manual',
    message: 'Paused via CLI',
  });
  return { status: 'paused', id };
}

export function resumeKshetraById(id: string): ResumeResult {
  const kshetra = loadRegistry().find(k => k.id === id);
  if (!kshetra) return { status: 'not_found', id };

  resumeKshetra(kshetra);
  return { status: 'resumed', id };
}