// Minimal centered shell for sign-in / sign-up (no sidebar).
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm animate-in">{children}</div>
    </div>
  );
}
