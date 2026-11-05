import { prisma } from '@/lib/db';

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'item'
  );
}

/** A workspace slug unique within an organization. */
export async function uniqueWorkspaceSlug(orgId: string, name: string): Promise<string> {
  const root = slugify(name);
  for (let i = 0; i < 50; i++) {
    const slug = i === 0 ? root : `${root}-${i}`;
    const existing = await prisma.workspace.findFirst({ where: { orgId, slug } });
    if (!existing) return slug;
  }
  return `${root}-${Date.now().toString(36)}`;
}
