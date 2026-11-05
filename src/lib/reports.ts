// Shared helpers for the Reports page + CSV export.

export const RANGES = ['7', '30', '90', 'all'] as const;
export type Range = (typeof RANGES)[number];

export function parseRange(value: string | undefined | null): Range {
  return (RANGES as readonly string[]).includes(value ?? '') ? (value as Range) : '30';
}

// A `createdAt` filter for the chosen range (null = all time).
export function rangeSince(range: Range): Date | null {
  if (range === 'all') return null;
  return new Date(Date.now() - Number(range) * 86_400_000);
}

export function rangeLabel(range: Range): string {
  return range === 'all' ? 'All time' : `Last ${range} days`;
}

export function csvField(value: unknown): string {
  const s = value == null ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ── CSV export ──────────────────────────────────────────────────────────────
// What a clinic can download. This replaced the Google Drive/Sheets export: no
// Google account, no extra OAuth scope, and it covers the records that actually
// matter to a practice rather than just call logs.

export const EXPORT_TYPES = ['calls', 'appointments', 'patients', 'outcomes'] as const;
export type ExportType = (typeof EXPORT_TYPES)[number];

export function parseExportType(value: string | undefined | null): ExportType {
  return (EXPORT_TYPES as readonly string[]).includes(value ?? '') ? (value as ExportType) : 'calls';
}

export const EXPORT_LABELS: Record<ExportType, string> = {
  calls: 'Calls',
  appointments: 'Appointments',
  patients: 'Patients',
  outcomes: 'Updates',
};

// What each export actually contains decides what it takes to download it.
//
// `call:read` used to gate all four, which quietly undid the distinction
// permissions.ts draws on purpose: `patient:read` is withheld from VIEWER so a
// read-only seat (auditor, demo login, front-desk stand-in) can see call history
// and no medical records. But a VIEWER has `call:read`, so `?type=patients`
// handed them the entire patient list with dates of birth — the exact leak the
// split permission exists to prevent.
//
// Lives here rather than in the route so the menu and the handler read the same
// table: the route enforces it, and the UI offers only what will not 403.
export const EXPORT_PERMISSION: Record<ExportType, 'call:read' | 'patient:read'> = {
  calls: 'call:read',
  outcomes: 'call:read',
  appointments: 'patient:read',
  patients: 'patient:read',
};

/** Join header + rows into a CSV body, quoting every field. */
export function toCsv(header: string[], rows: unknown[][]): string {
  return [header.map(csvField).join(','), ...rows.map((r) => r.map(csvField).join(','))].join('\n');
}
