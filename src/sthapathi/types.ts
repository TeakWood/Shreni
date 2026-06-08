// Shared types used across sthapathi modules

import type { KshetraConfig } from '../kshetra/config.js';

export interface AgentContext {
  kshetra: KshetraConfig;
  task: Task;
  projectMemory: string;
  taskDetails: string;
  universalSkills: string;
  projectSkills: string;
  scopedSkills: string;
  conventions: string;
  architecture: string;
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

export interface E2EOutput {
  testFilesAdded: string[];
  coverageGaps: { feature: string; description: string; priority: number }[];
}
