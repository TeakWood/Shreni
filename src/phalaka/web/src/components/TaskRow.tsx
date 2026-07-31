import { useEffect, useState } from 'react';
import type { BeadDetail, BeadSummary } from '../lib/types';
import { priorityLabel, statusBadgeClass } from '../lib/format';
import { fetchTaskDetail } from '../api/client';

interface Props {
  kshetraId: string;
  task: BeadSummary;
  token: string;
  expanded: boolean;
  onToggle: () => void;
}

function DetailField({ label, value }: { label: string; value?: string | null }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div className="mb-2">
      <div className="text-xs uppercase text-slate-500">{label}</div>
      <div className="whitespace-pre-wrap">{value}</div>
    </div>
  );
}

// One collapsed task row that lazy-loads its detail once, the first time it is
// expanded (mirrors the old openRow: detail is fetched at most once per row).
export function TaskRow({ kshetraId, task, token, expanded, onToggle }: Props) {
  const [detail, setDetail] = useState<BeadDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded || detail || loading) return;
    setLoading(true);
    setError(null);
    fetchTaskDetail(token, kshetraId, task.id)
      .then(d => setDetail(d))
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [expanded, detail, loading, token, kshetraId, task.id]);

  return (
    <div className="border-b border-slate-800 light:border-slate-200">
      <div
        className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-slate-800 light:hover:bg-slate-100"
        onClick={onToggle}
      >
        <span className={'px-2 py-0.5 rounded text-xs font-medium ' + statusBadgeClass(task.status)}>
          {task.status}
        </span>
        <span className="text-xs text-slate-400 light:text-slate-600">{priorityLabel(task.priority)}</span>
        <span className="flex-1 text-sm text-slate-200 light:text-slate-800">{task.title}</span>
        <span className="text-xs text-slate-600 light:text-slate-400 font-mono">{task.id}</span>
        {task.assignee ? <span className="text-xs text-slate-500">{task.assignee}</span> : null}
      </div>
      {expanded ? (
        <div className="px-4 py-3 bg-slate-900 text-sm text-slate-300 light:bg-white light:text-slate-700">
          {loading ? <span className="text-slate-500">Loading…</span> : null}
          {error ? <span className="text-red-400 light:text-red-600">{error}</span> : null}
          {detail ? <TaskDetail detail={detail} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function TaskDetail({ detail }: { detail: BeadDetail }) {
  const anyField =
    (detail.labels && detail.labels.length) ||
    detail.description ||
    detail.acceptance ||
    detail.design ||
    detail.notes ||
    detail.assignee ||
    detail.parent ||
    (detail.blockedBy && detail.blockedBy.length) ||
    detail.createdAt ||
    detail.updatedAt;
  if (!anyField) return <span className="text-slate-500">No details.</span>;
  return (
    <>
      {detail.labels && detail.labels.length ? (
        <DetailField label="Labels" value={detail.labels.join(', ')} />
      ) : null}
      <DetailField label="Description" value={detail.description} />
      <DetailField label="Acceptance" value={detail.acceptance} />
      <DetailField label="Design" value={detail.design} />
      <DetailField label="Notes" value={detail.notes} />
      <DetailField label="Assignee" value={detail.assignee} />
      <DetailField label="Parent" value={detail.parent} />
      {detail.blockedBy && detail.blockedBy.length ? (
        <DetailField label="Blocked by" value={detail.blockedBy.join(', ')} />
      ) : null}
      <DetailField label="Created" value={detail.createdAt} />
      <DetailField label="Updated" value={detail.updatedAt} />
    </>
  );
}
