export const ADMIN_THRESHOLDS = {
  staleTaskMinutes: 15,
  heavyFailureWindowMinutes: 60,
  heavyFailureMinCount: 10,
  heavyFailureRate: 0.5,
  heavyFailureMinSample: 5,
  refundRatioWindowHours: 24,
  refundChargeRatio: 0.3,
  recentFailedHours: 24,
  keyPoolFailureWindowMinutes: 10,
  keyPoolFailureRate: 0.3,
  keyPoolRecentErrorMinutes: 5,
} as const;

export function minutesAgoIso(minutes: number) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

export function hoursAgoIso(hours: number) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}
