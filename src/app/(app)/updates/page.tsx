import { redirect } from 'next/navigation';

// Updates merged into Appointments — they were two halves of the same question
// ("what did my agents do?"). Kept as a redirect rather than deleted so old
// bookmarks, and any link already sent out, land on the right tab.
export default function UpdatesPage() {
  redirect('/appointments?tab=updates');
}
