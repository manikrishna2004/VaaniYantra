'use client';

import { Button } from '@/components/ui';

/**
 * The invoice page is a server component; printing needs the browser. The
 * print stylesheet strips the app chrome, so "Save as PDF" from the print
 * dialog is the download path — no PDF library to keep up to date.
 */
export function PrintButton() {
  return (
    <Button size="sm" variant="secondary" onClick={() => window.print()}>
      Download / print
    </Button>
  );
}
