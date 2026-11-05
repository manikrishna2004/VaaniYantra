import type { Metadata } from 'next';

// Metadata-only wrapper: the page itself is a client component and cannot
// export metadata. Root layout's title template appends "— VaaniYantra".
export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to your VaaniYantra dashboard to manage AI voice agents, calls and appointments.',
};

export default function SignInLayout({ children }: { children: React.ReactNode }) {
  return children;
}
