import { notFound } from 'next/navigation';
import { requireWorkspace } from '@/lib/auth/context';
import { hasPermission } from '@/lib/auth/permissions';
import { doctorForUser } from '@/lib/doctors';
import { PageHeader, Card } from '@/components/ui';
import { DoctorSelfProfile } from '@/components/DoctorSelfProfile';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'My Practice' };

// Where a doctor lands after accepting their invite, and their home afterwards.
//
// Gated on calendar:write_self rather than on the DOCTOR role, because an owner
// who also sees patients is a doctor too and should have a profile like anyone
// else. What decides whether this page has anything to show is whether a Doctor
// row exists for them, not which role they hold.
export default async function MyPracticePage() {
  const ctx = await requireWorkspace();
  if (!hasPermission(ctx.role, 'calendar:write_self')) notFound();

  const doctor = await doctorForUser(ctx.org.id, ctx.user.id);

  if (!doctor) {
    return (
      <>
        <PageHeader title="My Practice" subtitle="Your profile, hours and calendar." />
        <Card>
          <p className="text-sm text-ink">You are not set up as a doctor at {ctx.org.name}.</p>
          <p className="mt-2 text-xs text-muted">
            Ask the practice owner to invite you as a doctor. Once they do, this page is where you set your name,
            specialisation, working hours and calendar.
          </p>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="My Practice"
        subtitle="Patients are booked with you from this. Keep your hours honest and the agent will too."
      />
      <DoctorSelfProfile
        doctor={{
          id: doctor.id,
          displayName: doctor.displayName,
          specialisation: doctor.specialisation,
          qualifications: doctor.qualifications,
          bio: doctor.bio,
          phone: doctor.phone,
          timezone: doctor.timezone,
          photoUrl: doctor.photoUrl,
          bookable: doctor.bookable,
          profileCompletedAt: doctor.profileCompletedAt?.toISOString() ?? null,
          active: doctor.active,
          userId: doctor.userId,
          userEmail: ctx.user.email,
          // Only used by the staff list's badge; this page has its own
          // "connect my calendar" card instead.
          hasCalendar: false,
        }}
      />
    </>
  );
}
