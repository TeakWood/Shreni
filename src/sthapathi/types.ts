// Shared types used across sthapathi modules

import type { KshetraConfig } from '../kshetra/config.js';

export interface AgentContext {
  kshetra: KshetraConfig;
  task: Task;
  projectMemory: string;
  taskDetails: string;
  // Cross-project skills from ~/.shreni/skills/SKILLS.md — no repo-native home,
  // so Shreni still injects them (the agent-execution design §3.1). Repo skills/rules,
  // the instruction file (CLAUDE.md/AGENTS.md/GEMINI.md), and the conventions
  // docs are NO LONGER injected — the provider CLI loads them natively, so
  // injecting them would double-load.
  universalSkills: string;
  // Reviewer-only custom review instructions (the agent-execution design §3.3 channel
  // B), loaded from conventions.reviewGuide. Injected ONLY into the Viharapala
  // prompt (Silpi ignores it); '' when unset. This is Shreni-injected rather than
  // native because no provider offers a reviewer-only instruction file.
  reviewGuide: string;
  // NOT YET IMPLEMENTED: relevant-code chunks from RAG retrieval. Always '' today
  // (dispatch.ts) — retrieval is not wired up. Kept in the contract so the
  // injection site is ready once it lands.
  ragChunks: string;
}

export interface Task {
  id: string;
  slug: string;
  title: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'blocked' | 'closed';
  priority: number;
  round?: number;
  notes?: string;
  context?: {
    relatedFiles?: string[];
  };
}

export interface SilpiOutput {
  filesChanged: { path: string; diff: string }[];
  testFiles: string[];
  summary: string;
  confidenceScore: number;
  questionsForReviewer: string[];
  lintPassed: boolean;
  testsPassed: boolean;
  insights: string[];
}

export interface ViharapalaOutput {
  verdict: 'APPROVE' | 'REJECT';
  overallScore: number;
  mustFix: string[];
  suggestions: string[];
  issues: {
    severity: 'blocker' | 'major' | 'minor';
    file?: string;
    description: string;
  }[];
  insights: string[];
}

export interface ParikshakaOutput {
  coverageGaps: { feature: string; description: string; priority: number }[];
}
