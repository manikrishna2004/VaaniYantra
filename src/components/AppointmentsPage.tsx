'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { SegmentedTabs } from '@/components/ui';
import { AppointmentsManager } from '@/components/AppointmentsManager';
import { OutcomesFeed } from '@/components/OutcomesFeed';
import { ExportMenu } from '@/components/ExportMenu';
import { BookAppointment } from '@/components/BookAppointment';

// The bookings your agents made, and the other things they captured on calls,
// on one page.
//
// Deliberately two tabs rather than one interleaved stream: an appointment is a
// row you act on (cancel it, export it) while an update is a read-only record
// of what a call produced. They share no sort key and no actions, so merging
// them chronologically would bury the bookings that actually need attention.
export type AppointmentsTab = 'appointments' | 'updates';

const SUBTITLES: Record<AppointmentsTab, string> = {
  appointments:
    'Bookings your agents made on calls and in the chatbot. Reminders go out automatically 24 hours and 1 hour before.',
  updates:
    'Everything else your agents captured on calls — enquiries, callbacks and requests. The same events are texted to you as they happen.',
};

export function AppointmentsPage({
  canManage,
  defaultTab,
}: {
  canManage: boolean;
  defaultTab: AppointmentsTab;
}) {
  const [tab, setTab] = useState<AppointmentsTab>(defaultTab);
  // Bumped after a booking so the list remounts and refetches — simpler than
  // threading a refresh handle down through the manager.
  const [reloadKey, setReloadKey] = useState(0);
  const router = useRouter();

  function select(next: AppointmentsTab) {
    setTab(next);
    // Keep the tab in the URL so it survives a refresh and can be linked to —
    // this is the address /updates now redirects to. replace(), not push(), so
    // switching tabs doesn't fill up the back button.
    router.replace(next === 'appointments' ? '/appointments' : `/appointments?tab=${next}`, { scroll: false });
  }

  return (
    <>
      <div className="mb-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="h-display text-2xl font-semibold sm:text-[28px]">Appointments</h1>
            <p className="mt-1.5 text-sm text-muted">{SUBTITLES[tab]}</p>
          </div>
          <div className="flex items-center gap-2">
            <ExportMenu range="all" only={tab === 'appointments' ? 'appointments' : 'outcomes'} />
            {canManage && tab === 'appointments' && (
              <BookAppointment onBooked={() => setReloadKey((k) => k + 1)} />
            )}
          </div>
        </div>
        <SegmentedTabs
          className="mt-5"
          label="Appointments view"
          value={tab}
          onChange={select}
          options={[
            { value: 'appointments', label: 'Appointments' },
            { value: 'updates', label: 'Updates' },
          ]}
        />
      </div>

      {tab === 'appointments' ? (
        <AppointmentsManager key={reloadKey} canManage={canManage} />
      ) : (
        <OutcomesFeed />
      )}
    </>
  );
}
