'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { signOut } from 'firebase/auth';
import {
  LayoutDashboard,
  Bot,
  Radio,
  PhoneOutgoing,
  CalendarClock,
  CalendarDays,
  BarChart3,
  BookOpen,
  MessageCircle,
  Plug,
  Hash,
  Users,
  UserRound,
  Settings,
  LifeBuoy,
  Star,
  Zap,
  LogOut,
  Menu,
  X,
  type LucideIcon,
  Stethoscope,
} from 'lucide-react';
import { auth } from '@/lib/firebase/client';
import { cn } from '@/lib/utils';
import { hasPermission, type Permission, type Role } from '@/lib/auth/permissions';
import { WorkspaceSwitcher } from '@/components/WorkspaceSwitcher';

// Grouped so a 12-item list reads as scannable sections, not one long column.
// `perm`, where present, hides the item from roles that cannot open it — better
// than showing a link that leads to a 404 or an empty screen.
const NAV_GROUPS: {
  label: string | null;
  items: { href: string; label: string; icon: LucideIcon; perm?: Permission }[];
}[] = [
  {
    label: null,
    items: [
      // Clinic-wide oversight: ADMIN and OWNER only. A front-desk seat works the
      // appointment book and a doctor works their own calendar — homePathFor()
      // sends each of them somewhere they can actually use.
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, perm: 'insights:read' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { href: '/agents', label: 'Agents', icon: Bot, perm: 'agent:write' },
      { href: '/live', label: 'Live Calls', icon: Radio, perm: 'insights:read' },
      { href: '/calls', label: 'Call History', icon: PhoneOutgoing, perm: 'call:read' },
      { href: '/appointments', label: 'Appointments', icon: CalendarClock },
      // No `perm`: staff reach it through call:read, a doctor through
      // calendar:read_self, and the route scopes the rows either way. Gating on
      // one permission here would hide it from the other.
      { href: '/calendar', label: 'Calendar', icon: CalendarDays },
      { href: '/patients', label: 'Patients', icon: UserRound, perm: 'patient:read' },
      { href: '/reports', label: 'Reports', icon: BarChart3, perm: 'insights:read' },
    ],
  },
  {
    label: 'Setup',
    items: [
      // A doctor's own home. Gated on calendar:write_self rather than the role,
      // so an owner who also sees patients gets it too.
      { href: '/my-practice', label: 'My Practice', icon: Stethoscope, perm: 'calendar:write_self' },
      // The API refuses a doctor here now (they hold neither knowledge:read nor
      // :write), so linking it for them would only offer a dead end.
      { href: '/knowledge', label: 'Knowledge Base', icon: BookOpen, perm: 'knowledge:read' },
      { href: '/chatbot', label: 'Patient Chatbot', icon: MessageCircle },
      // Setup is the owner's. These three all lead to screens whose every
      // control is now refused below the permission named, so linking them for
      // staff would only offer a dead end.
      // NOT integration:manage. A doctor reaches this page to attach their own
      // Google calendar, which is integration:connect_self — gating on the
      // org-wide permission would hide the only route they have to it. The page
      // itself degrades: ConnectorsManager takes canManage separately.
      { href: '/connectors', label: 'Connectors', icon: Plug, perm: 'integration:connect_self' },
      { href: '/numbers', label: 'Phone Numbers', icon: Hash, perm: 'number:write' },
      { href: '/team', label: 'Team', icon: Users, perm: 'member:manage' },
      { href: '/settings', label: 'Settings', icon: Settings },
      { href: '/docs', label: 'Help & Docs', icon: LifeBuoy },
    ],
  },
];

type SidebarProps = {
  user: { email: string; name: string | null; imageUrl: string | null };
  org: { name: string };
  workspace: { name: string };
  role: Role;
  isSuperAdmin?: boolean;
};

export function Sidebar(props: SidebarProps) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Lock body scroll while the mobile drawer is open.
  useEffect(() => {
    document.body.style.overflow = mobileOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [mobileOpen]);

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-border bg-surface lg:flex">
        <SidebarContent {...props} />
      </aside>

      {/* Mobile top bar */}
      <header className="fixed inset-x-0 top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-surface px-4 lg:hidden">
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-label="Open navigation menu"
          className="grid h-9 w-9 place-items-center rounded-lg text-ink hover:bg-surface-2"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-2">
          <img src="/logo.png" alt="VaaniYantra" className="h-7 w-auto" />
          <span className="h-display text-sm font-semibold">VaaniYantra</span>
        </div>
      </header>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-ink/40 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-border bg-surface shadow-xl animate-in">
            <SidebarContent {...props} onNavigate={() => setMobileOpen(false)} showClose onClose={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}
    </>
  );
}

function SidebarContent({
  user,
  org,
  workspace,
  role,
  isSuperAdmin,
  onNavigate,
  showClose,
  onClose,
}: SidebarProps & {
  onNavigate?: () => void;
  showClose?: boolean;
  onClose?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut(auth).catch(() => {});
      await fetch('/api/auth/session', { method: 'DELETE' });
    } finally {
      router.push('/sign-in');
      router.refresh();
    }
  }

  const initial = (user.name || user.email || '?').charAt(0).toUpperCase();

  return (
    <>
      <div className="space-y-3 px-4 py-5">
        <div className="flex items-center justify-between gap-2.5 px-2">
          <div className="flex items-center gap-2.5">
            <img src="/logo.png" alt="VaaniYantra" className="h-8 w-auto" />
            <span className="h-display text-base font-semibold">VaaniYantra</span>
          </div>
          {showClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close navigation menu"
              className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <WorkspaceSwitcher initialOrgName={org.name} initialWorkspaceName={workspace.name} />
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto px-3 pb-2">
        {NAV_GROUPS.map((group, gi) => (
          <div key={gi} className="space-y-1">
            {group.label && (
              <div className="px-3.5 pb-1 text-[10px] font-semibold uppercase tracking-widest text-muted/70">
                {group.label}
              </div>
            )}
            {group.items.map((item) => {
              if (item.perm && !hasPermission(role, item.perm)) return null;
              const active = pathname === item.href || pathname.startsWith(item.href + '/');
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onNavigate}
                  className={cn(
                    'group relative flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm transition',
                    active
                      ? 'bg-primary-soft text-primary'
                      : 'text-ink-soft hover:bg-surface-2 hover:text-ink',
                  )}
                >
                  {active && <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary" />}
                  <Icon className={cn('h-[18px] w-[18px] shrink-0', active ? 'text-primary' : 'text-muted group-hover:text-ink')} />
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
        {isSuperAdmin && (
          <Link
            href="/admin"
            onClick={onNavigate}
            className={cn(
              'mt-1 flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm transition',
              pathname === '/admin' || pathname.startsWith('/admin/')
                ? 'bg-primary-soft text-primary'
                : 'text-ink-soft hover:bg-surface-2 hover:text-ink',
            )}
          >
            <Star className="h-[18px] w-[18px] shrink-0 text-primary" />
            Admin
          </Link>
        )}
      </nav>

      <div className="border-t border-border px-3 py-4">
        {/* Only the owner pays, so only the owner is asked to. Billing is
            billing:manage now, so showing this to anyone else offered a button
            that lands on a 404 — and invited a doctor to wonder why the clinic
            wants money from them. */}
        {hasPermission(role, 'billing:manage') && (
          <Link
            href="/settings/billing"
            onClick={onNavigate}
            className={cn(
              'mb-3 flex items-center justify-center gap-2 rounded-xl border px-3.5 py-2.5 text-sm font-medium transition',
              pathname === '/settings/billing'
                ? 'border-primary/50 bg-primary-soft text-primary'
                : 'border-primary/30 bg-primary-soft text-primary hover:border-primary/60 hover:bg-primary/20',
            )}
          >
            <Zap className="h-4 w-4" />
            Upgrade plan
          </Link>
        )}
        <div className="flex items-center gap-3 rounded-xl px-2.5 py-2">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-2 text-sm font-medium text-ink">
            {initial}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm text-ink">{user.name || user.email}</div>
            <div className="truncate text-[11px] text-muted capitalize">{role.toLowerCase()}</div>
          </div>
        </div>
        <button
          onClick={handleSignOut}
          disabled={signingOut}
          className="mt-2 flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-muted transition hover:bg-surface-2 hover:text-ink disabled:opacity-50"
        >
          <LogOut className="h-[18px] w-[18px] shrink-0" />
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
    </>
  );
}
