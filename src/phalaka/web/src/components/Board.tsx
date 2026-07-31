import { useState } from 'react';
import type { KshetraSummary } from '../lib/types';
import { KshetraCard } from './KshetraCard';

interface Props {
  kshetras: KshetraSummary[];
  token: string;
  showClosed: boolean;
  error: string | null;
  /** Bumped on each live board refresh so cards re-pull their task lists. */
  refreshTick: number;
}

// The board owns the fleet-wide "one expanded row at a time" selection so opening
// a task in one Kshetra collapses whatever was open in another.
export function Board({ kshetras, token, showClosed, error, refreshTick }: Props) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  if (error) return <div className="text-red-400 text-sm">{error}</div>;

  return (
    <div>
      {kshetras.map(k => (
        <KshetraCard
          key={k.id}
          kshetra={k}
          token={token}
          showClosed={showClosed}
          expandedKey={expandedKey}
          onToggleRow={setExpandedKey}
          refreshTick={refreshTick}
        />
      ))}
    </div>
  );
}
