import type { TimeUsageSourceTable, TimeUsageStatusGroup } from './classification';

export type TimeUsageFilters = {
  since: string;
  until: string;
  ownerId?: number | null;
  moduleKey?: string | null;
  featureKey?: string | null;
  status?: string | null;
  query?: string | null;
  limit?: number;
  offset?: number;
};

export type TimeUsageDetailRow = {
  sourceTable: TimeUsageSourceTable;
  sourceId: string;
  createdAt: string;
  startedAt: string;
  endedAt: string | null;
  waitMs: number | null;
  ownerId: number | null;
  username: string | null;
  projectId: string | null;
  projectTitle: string | null;
  projectDisplay: string;
  moduleKey: string;
  moduleLabel: string;
  featureKey: string;
  featureLabel: string;
  callItemType: string;
  callItemId: string;
  callItemLabel: string | null;
  status: string;
  statusGroup: TimeUsageStatusGroup;
  isTerminal: boolean;
  provider: string | null;
  errorMessage: string | null;
};

export type TimeUsageSummary = {
  total: number;
  terminal: number;
  active: number;
  users: number;
  success: TimeUsageMetricGroup;
  partialSuccess: TimeUsageMetricGroup;
  failed: TimeUsageMetricGroup;
  cancelled: TimeUsageMetricGroup;
  activeLongestWaitMs: number;
};

export type TimeUsageMetricGroup = {
  count: number;
  avgWaitMs: number | null;
  p95WaitMs: number | null;
  maxWaitMs: number | null;
};
