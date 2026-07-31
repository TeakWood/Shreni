import { useState } from 'react';
import type { TriageEntry } from '../lib/triage';
import { triageSeverityClass } from '../lib/triage';

interface Props {
  entries: TriageEntry[];
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, done);
    } else {
      done();
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      className="shrink-0 text-xs px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 light:bg-slate-200 light:hover:bg-slate-300 light:text-slate-800"
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

function TriageRow({ entry }: { entry: TriageEntry }) {
  return (
    <div className="px-3 py-2 border-b border-slate-800 light:border-slate-200">
      <div className="flex items-center gap-3">
        <span className={'px-2 py-0.5 rounded text-xs font-medium ' + triageSeverityClass(entry.severity)}>
          {entry.severity}
        </span>
        <span className="text-sm font-medium text-slate-100 light:text-slate-900">{entry.label}</span>
        {entry.beadId ? <span className="text-xs text-slate-500 font-mono">{entry.beadId}</span> : null}
        <span className="flex-1" />
        <CopyButton text={entry.remediation} />
      </div>
      <div className="mt-1 text-xs text-slate-300 light:text-slate-700">{entry.reason}</div>
      <pre className="mt-2 px-2 py-1.5 rounded bg-slate-950 text-xs text-emerald-200 light:bg-slate-100 light:text-emerald-700 whitespace-pre-wrap overflow-x-auto">
        {entry.remediation}
      </pre>
    </div>
  );
}

// Fleet-wide "needs a human" feed. Pure render of the aggregated entries; the
// copy button carries the remediation so a click copies it verbatim — the exact
// seam the Phase-2 action buttons will replace in place.
export function TriageFeed({ entries }: Props) {
  return (
    <section className="mb-6 rounded border border-slate-800 light:border-slate-200 overflow-hidden">
      <div className="flex items-center gap-3 px-3 py-2 bg-slate-800 light:bg-slate-100">
        <h2 className="text-sm font-semibold text-slate-100 light:text-slate-900">Needs a human</h2>
        <span
          className={
            'text-xs px-1.5 py-0.5 rounded ' +
            (entries.length
              ? 'bg-red-800 text-red-100 light:bg-red-100 light:text-red-800'
              : 'bg-slate-700 text-slate-400 light:bg-slate-200 light:text-slate-600')
          }
        >
          {entries.length}
        </span>
        <span className="text-xs text-slate-500">fleet-wide triage</span>
      </div>
      <div>
        {entries.length === 0 ? (
          <div className="px-3 py-2 text-sm text-emerald-300 light:text-emerald-700">
            ✓ Nothing needs a human — the fleet is healthy.
          </div>
        ) : (
          entries.map(entry => <TriageRow key={entry.key} entry={entry} />)
        )}
      </div>
    </section>
  );
}
