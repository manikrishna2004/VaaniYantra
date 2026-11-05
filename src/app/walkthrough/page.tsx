import { permanentRedirect } from 'next/navigation';

// /walkthrough is retired. We no longer offer a slot on a calendar before
// knowing anything about the practice — the same conversation now starts on
// /contact by asking what they need.
//
// A redirect rather than a deletion: this URL is in sent emails, in the sitemap
// Google has already crawled, and in older marketing collateral. 308 tells
// search engines the address moved for good, so the ranking follows it instead
// of dying on a 404.
export default function WalkthroughPage() {
  permanentRedirect('/contact');
}
