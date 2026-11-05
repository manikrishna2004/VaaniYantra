'use client';

import { Field, Input, Select } from '@/components/ui';
import { COMMON_TIMEZONES, DAY_LABELS, DAY_ORDER, type BusinessHours } from '@/lib/agent-behavior';

// The Mon–Sun opening-hours editor.
//
// Extracted from AgentForm, where it was inline JSX, so the agent's business
// hours and a doctor's working hours are edited by the same component over the
// same `{open, close, closed}` shape. Two editors for one shape is how the hours
// a clinic answers calls in start disagreeing with the hours it books in.
//
// Presentational only: it owns no state and does no fetching. The caller holds
// the value and decides what saving means.

export function WeeklyHours({
  value,
  onChange,
  disabled = false,
  showTimezone = true,
}: {
  value: BusinessHours;
  onChange: (next: BusinessHours) => void;
  disabled?: boolean;
  showTimezone?: boolean;
}) {
  function setDay(idx: number, patch: Partial<BusinessHours['days'][number]>) {
    onChange({ ...value, days: value.days.map((d, i) => (i === idx ? { ...d, ...patch } : d)) });
  }

  return (
    <div className="space-y-3">
      {showTimezone && (
        <Field label="Timezone">
          <Select
            value={value.timezone}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, timezone: e.target.value })}
          >
            {COMMON_TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <div className="space-y-1.5">
        {/* Mon-first for reading; the array itself stays getDay()-indexed. */}
        {DAY_ORDER.map((dayIdx) => {
          const d = value.days[dayIdx];
          if (!d) return null;
          return (
            <div key={dayIdx} className="flex items-center gap-2 text-sm">
              <span className="w-24 shrink-0 text-muted">{DAY_LABELS[dayIdx]}</span>
              <label className="flex items-center gap-1.5 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={!d.closed}
                  disabled={disabled}
                  onChange={(e) => setDay(dayIdx, { closed: !e.target.checked })}
                  className="h-3.5 w-3.5 accent-primary"
                />
                open
              </label>
              {!d.closed && (
                <>
                  <Input
                    type="time"
                    value={d.open}
                    disabled={disabled}
                    onChange={(e) => setDay(dayIdx, { open: e.target.value })}
                    className="w-28"
                  />
                  <span className="text-muted">–</span>
                  <Input
                    type="time"
                    value={d.close}
                    disabled={disabled}
                    onChange={(e) => setDay(dayIdx, { close: e.target.value })}
                    className="w-28"
                  />
                </>
              )}
              {d.closed && <span className="text-xs text-muted">closed</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
