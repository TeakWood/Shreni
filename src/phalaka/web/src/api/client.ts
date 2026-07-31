// Typed fetch client for the Phalaka backend (src/phalaka/api.ts). The page reads
// the shared token from its own URL (location.search) and attaches it to every
// API path — same scheme as the old vanilla bootstrap.

import type {
  BeadDetail,
  KshetraSummary,
  ProcessSnapshot,
  TaskListResponse,
} from '../lib/types';

// Attach the shared token to an API path (ported verbatim from ui.ts::apiUrl).
export function apiUrl(path: string, token: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return path + sep + 'token=' + encodeURIComponent(token);
}

export function readToken(): string {
  return new URLSearchParams(location.search).get('token') || '';
}

async function getJson<T>(path: string, token: string): Promise<T> {
  const r = await fetch(apiUrl(path, token));
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return (await r.json()) as T;
}

export function fetchKshetras(token: string): Promise<KshetraSummary[]> {
  return getJson<KshetraSummary[]>('/api/kshetras', token);
}

export function fetchProcesses(token: string): Promise<ProcessSnapshot[]> {
  return getJson<ProcessSnapshot[]>('/api/processes', token);
}

export function fetchTasks(
  token: string,
  kshetraId: string,
  status?: string,
): Promise<TaskListResponse> {
  const base = '/api/kshetras/' + encodeURIComponent(kshetraId) + '/tasks';
  return getJson<TaskListResponse>(status ? base + '?status=' + encodeURIComponent(status) : base, token);
}

export function fetchTaskDetail(
  token: string,
  kshetraId: string,
  beadId: string,
): Promise<BeadDetail> {
  return getJson<BeadDetail>(
    '/api/kshetras/' + encodeURIComponent(kshetraId) + '/tasks/' + encodeURIComponent(beadId),
    token,
  );
}
