import type { Metadata } from 'next';
import { INDIAN_LANGUAGE_COUNT } from '@/lib/constants';

// Metadata-only wrapper. Root layout's title template appends "— VaaniYantra".
//
// No longer sells a free trial: accounts are invite-only, and this page is
// mostly reached by an invited colleague or by someone who guessed the URL.
export const metadata: Metadata = {
  title: 'Create your account',
  description: `VaaniYantra is invite-only while we onboard clinics one at a time. Talk to us and we will set up an AI receptionist that answers calls in Hinglish, Tanglish and ${INDIAN_LANGUAGE_COUNT} Indian languages.`,
};

export default function SignUpLayout({ children }: { children: React.ReactNode }) {
  return children;
}
