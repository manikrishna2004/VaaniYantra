import { PageSkeleton } from '@/components/ui';

// Route-group loading state. Next applies this to every nested route that has
// no loading.tsx of its own, so all fourteen dashboard pages paint structure
// immediately instead of holding a blank screen while the server renders.
//
// A skeleton rather than a spinner: these pages have a known shape (header,
// then a stack of cards), so reserving that shape stops content jumping when
// data lands and makes the wait read as progress.
export default function Loading() {
  return <PageSkeleton rows={3} />;
}
