import { defineLifecycle } from '../../taskgraph';
import { checksPassed, childrenSettled, hasOpenPr } from './guards';

// Shreni's task lifecycle (policy spec, "The lifecycle"): eight states and
// thirteen moves. Bump the version on every change; a guard whose source
// changes needs a bump too (guard-snapshot.test.ts).

const nonTerminal = ['proposed', 'open', 'claimed', 'waiting', 'blocked', 'parked'];

export const taskLifecycle = defineLifecycle({
  name: 'shreni.task',
  version: 1,
  states: {
    proposed: {},
    open: { claimable: true },
    claimed: { leased: true },
    waiting: {},                         // e.g. a PR is open
    blocked: {},                         // needs a human
    parked: {},                          // set aside on purpose
    done: { satisfiesDeps: true, terminal: true },
    cancelled: { terminal: true },
  },
  create: { state: 'proposed', byRole: { system: 'open' } },   // only policy jobs skip approval
  moves: [   // by: the roles that may make the move; only the expiry hooks act as system
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
    // containers are never claimed; Sthapathi, or the developer in a tracker project, completes one once its children settle
    { name: 'completeContainer', from: ['open'], to: 'done', by: ['orchestrator', 'developer'], guard: childrenSettled },
  ],
  permissions: {   // calls that aren't moves: role -> true (any state) or the states the task may be in
    'tasks.create': { developer: true, planner: true, system: true, agent: true },
    'tasks.update': { developer: ['proposed', 'open', 'blocked', 'parked'], planner: ['proposed'] },
    'tasks.delete': { developer: ['proposed'], planner: ['proposed'] },
    'deps.add': { developer: true, planner: ['proposed'] },   // the state of the task that waits
    'deps.remove': { developer: true, planner: ['proposed'] },
    'links.add': { developer: true, planner: true, orchestrator: true, agent: true },
    'notes.add': { developer: true, orchestrator: true, agent: true },
    'plans.create': { developer: true, planner: true },
    'plans.validate': { developer: true, planner: true },
    'lifecycles.activate': { developer: true },   // shreni task upgrade
  },
  hooks: {
    onApprove: 'approve', onClaim: 'claim', onDiscard: 'cancel', onLeaseExpiry: 'expire',
    onRepeatedExpiry: { after: 3, move: 'flag' },   // the third expiry in a row blocks the task
  },
});
