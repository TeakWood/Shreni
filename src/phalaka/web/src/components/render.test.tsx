import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TriageFeed } from './TriageFeed';
import { ProcessPanel } from './ProcessPanel';
import type { ProcessSnapshot } from '../lib/types';

// These replace the old renderTriageEntry / renderProcessRow / renderTriageFeed
// string-render tests: the components are pure, so renderToStaticMarkup gives the
// same coverage over the ported render logic without a DOM.

describe('TriageFeed', () => {
  it('shows a healthy empty state when nothing needs a human', () => {
    const html = renderToStaticMarkup(<TriageFeed entries={[]} />);
    expect(html).toContain('Nothing needs a human');
  });

  it('renders a severity pill, escaped fields and a copyable command per entry', () => {
    const html = renderToStaticMarkup(
      <TriageFeed
        entries={[
          {
            key: 'stuck:worker:proj',
            severity: 'stuck',
            label: 'proj',
            reason: 'hung on <thing>',
            remediation: 'shreni resume --kshetra proj',
            beadId: 'proj-7',
          },
          { key: 'k2', severity: 'blocked', label: 'b', reason: 'r', remediation: 'c2' },
        ]}
      />,
    );
    expect(html).toContain('hung on &lt;thing&gt;'); // JSX-escaped reason
    expect(html).toContain('proj-7');
    expect(html).toContain('shreni resume --kshetra proj'); // command shown verbatim
    expect(html).toContain('Copy');
    expect(html).toContain('<pre');
    expect(html.match(/<button/g)!.length).toBe(2); // one copy button per entry
  });
});

describe('ProcessPanel', () => {
  const worker: ProcessSnapshot = {
    kind: 'worker',
    kshetraId: 'proj',
    pid: 4321,
    status: 'working',
    phase: 'CODING',
    heartbeatAgeMs: 12_000,
    paused: false,
    activeBead: { id: 'proj-9', title: 'Build <thing>' },
  };

  it('renders the status pill, phase, heartbeat age, pid and active bead', () => {
    const html = renderToStaticMarkup(
      <ProcessPanel processes={[worker]} streamStatus="live" error={null} />,
    );
    expect(html).toContain('working'); // status pill
    expect(html).toContain('CODING'); // phase chip
    expect(html).toContain('12s'); // heartbeat age
    expect(html).toContain('pid 4321');
    expect(html).toContain('proj-9'); // active bead
    expect(html).toContain('Build &lt;thing&gt;'); // escaped title attr
    expect(html).toContain('live'); // stream-status chip
  });

  it('omits the heartbeat chip for a service with no heartbeat', () => {
    const service: ProcessSnapshot = { kind: 'phalaka', pid: 10, status: 'healthy', paused: false };
    const html = renderToStaticMarkup(
      <ProcessPanel processes={[service]} streamStatus="live" error={null} />,
    );
    expect(html).toContain('pid 10');
    expect(html).not.toContain('♥');
  });

  it('shows an empty state when there are no processes', () => {
    const html = renderToStaticMarkup(<ProcessPanel processes={[]} streamStatus="connecting" error={null} />);
    expect(html).toContain('No processes.');
  });
});
