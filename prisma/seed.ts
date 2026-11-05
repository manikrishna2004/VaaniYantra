import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Seeds a demo organization + workspace with a couple of starter agents and a
// number, so there is sample content and the legacy voice-server fallback
// (getCurrentUser → demo@vaani.ai) keeps working. Real users get their own
// organization + workspace provisioned on first Firebase sign-in.
async function main() {
  const org = await prisma.organization.upsert({
    where: { slug: 'demo' },
    update: {},
    create: { name: 'Demo Organization', slug: 'demo' },
  });

  const workspace = await prisma.workspace.upsert({
    where: { orgId_slug: { orgId: org.id, slug: 'default' } },
    update: {},
    create: { orgId: org.id, name: 'Default', slug: 'default' },
  });

  const user = await prisma.user.upsert({
    where: { email: 'demo@vaani.ai' },
    update: {},
    create: { email: 'demo@vaani.ai', name: 'Demo User' },
  });

  await prisma.membership.upsert({
    where: { userId_orgId: { userId: user.id, orgId: org.id } },
    update: {},
    create: { userId: user.id, orgId: org.id, role: 'OWNER' },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { activeWorkspaceId: workspace.id },
  });

  const support = await prisma.agent.upsert({
    where: { id: 'seed-agent-support' },
    update: { workspaceId: workspace.id },
    create: {
      id: 'seed-agent-support',
      workspaceId: workspace.id,
      userId: user.id,
      name: 'Support Assistant',
      description: 'Answers customer support questions in English.',
      systemPrompt:
        'You are a friendly customer support assistant for a small business. Keep replies short and natural for a phone call. Be warm and helpful.',
      greeting: 'Hi! Thanks for calling support. How can I help you today?',
      language: 'en-IN',
      voice: 'en-IN-Neural2-A',
      direction: 'BOTH',
      maxCallSeconds: 600,
      temperature: 0.6,
    },
  });

  await prisma.agent.upsert({
    where: { id: 'seed-agent-hindi' },
    update: { workspaceId: workspace.id },
    create: {
      id: 'seed-agent-hindi',
      workspaceId: workspace.id,
      userId: user.id,
      name: 'हिन्दी सहायक (Hindi Helpdesk)',
      description: 'Handles inbound queries in Hindi.',
      systemPrompt:
        'आप एक मित्रवत हेल्पडेस्क सहायक हैं। फ़ोन कॉल के लिए संक्षिप्त और स्वाभाविक उत्तर दें।',
      greeting: 'नमस्ते! कॉल करने के लिए धन्यवाद। मैं आपकी कैसे मदद कर सकता हूँ?',
      language: 'hi-IN',
      voice: 'hi-IN-Neural2-A',
      direction: 'INBOUND',
      maxCallSeconds: 600,
      temperature: 0.6,
    },
  });

  await prisma.phoneNumber.upsert({
    where: { e164: '+919000000001' },
    update: { agentId: support.id, workspaceId: workspace.id },
    create: {
      workspaceId: workspace.id,
      userId: user.id,
      e164: '+919000000001',
      label: 'Main support line',
      provider: 'mock',
      agentId: support.id,
    },
  });

  console.log('Seeded demo org, workspace, user, agents, and a phone number.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
