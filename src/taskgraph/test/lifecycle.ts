import { defineGuard, type Lifecycle } from '../lifecycle';

// A lifecycle shaped like Shreni's (policy spec, "The lifecycle"), for engine
// tests. Each call returns a fresh copy, so a test can change it freely. The
// guards allow every move; tests that need a refusal swap in their own.

const hasOpenPr = defineGuard('hasOpenPr', async () => true);
const checksPassed = defineGuard('checksPassed', async () => true);
const childrenSettled = defineGuard('childrenSettled', async () => true);

export function testLifecycle(): Lifecycle {
  const nonTerminal = ['proposed', 'open', 'claimed', 'waiting', 'blocked', 'parked'];
  return {
    name: 'test.task',
    version: 1,
    states: {
      proposed: {},
      open: { claimable: true },
      claimed: { leased: true },
      waiting: {},
      blocked: {},
      parked: {},
      done: { satisfiesDeps: true, terminal: true },
      cancelled: { terminal: true },
    },
    create: { state: 'proposed', byRole: { system: 'open' } },
    moves: [
      { name: 'approve', from: ['proposed'], to: 'open', by: ['developer'] },
      { name: 'claim', from: ['open'], to: 'claimed', by: ['orchestrator', 'developer'] },
      { name: 'release', from: ['claimed'], to: 'open', by: ['orchestrator', 'developer'] },
      { name: 'expire', from: ['claimed'], to: 'open', by: ['system'] },
      { name: 'submit', from: ['claimed'], to: 'waiting', by: ['orchestrator'], guard: hasOpenPr, clearsBoost: true },
      { name: 'finish', from: ['claimed', 'waiting'], to: 'done', by: ['orchestrator', 'developer'], guard: checksPassed, clearsBoost: true },
      { name: 'followUp', from: ['waiting'], to: 'open', by: ['orchestrator'], boost: true },
      { name: 'flag', from: ['open', 'claimed', 'waiting'], to: 'blocked', by: ['orchestrator', 'system'] },
      { name: 'unblock', from: ['blocked'], to: 'open', by: ['developer'] },
      { name: 'park', from: ['proposed', 'open', 'blocked'], to: 'parked', by: ['developer'] },
      { name: 'unpark', from: ['parked'], to: 'open', by: ['developer'] },
      { name: 'cancel', from: nonTerminal, to: 'cancelled', by: ['developer'], clearsBoost: true },
      { name: 'completeContainer', from: ['open'], to: 'done', by: ['orchestrator', 'developer'], guard: childrenSettled },
    ],
    permissions: {
      'tasks.create': { developer: true, planner: true, system: true, agent: true },
      'tasks.update': { developer: ['proposed', 'open', 'blocked', 'parked'], planner: ['proposed'] },
      'tasks.delete': { developer: ['proposed'], planner: ['proposed'] },
      'deps.add': { developer: true, planner: ['proposed'] },
      'deps.remove': { developer: true, planner: ['proposed'] },
      'links.add': { developer: true, planner: true, orchestrator: true, agent: true },
      'notes.add': { developer: true, orchestrator: true, agent: true },
      'plans.create': { developer: true, planner: true },
      'plans.validate': { developer: true, planner: true },
      'lifecycles.activate': { developer: true },
    },
    hooks: {
      onApprove: 'approve', onClaim: 'claim', onDiscard: 'cancel', onLeaseExpiry: 'expire',
      onRepeatedExpiry: { after: 3, move: 'flag' },
    },
  };
}
