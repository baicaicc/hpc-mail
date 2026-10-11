import { userMailboxPolicySchema, type Settings, type UserMailboxPolicy } from '@hpc-mail/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import { AppError } from '../lib/errors.js';

export type MailboxPolicyUser = Pick<typeof users.$inferSelect, 'id' | 'role' | 'status' | 'mailboxPolicy' | 'mailboxPolicyRevision'>;

export interface EffectiveMailboxPolicy {
  perUserLimit: number;
  domains: UserMailboxPolicy['domains'];
  reservedLocalParts: string[];
}

/** 唯一的权限解析：专属配置替代公共域名及额度，但仍需域名存在于系统中。 */
export function resolveMailboxPolicy(settings: Settings, user: MailboxPolicyUser): EffectiveMailboxPolicy {
  if (user.role === 'admin') {
    return { perUserLimit: 0, domains: settings.domains.list.map(({ domain }) => ({ domain, perUserLimit: 0 })), reservedLocalParts: [] };
  }
  if (user.mailboxPolicy !== null) {
    const parsed = userMailboxPolicySchema.safeParse(user.mailboxPolicy);
    // 存储损坏不能降级成更宽松的公共权限。
    if (!parsed.success) throw new AppError('internal', '邮箱权限配置无效，请联系管理员');
    const configured = new Set(settings.domains.list.map(({ domain }) => domain));
    return { ...parsed.data, domains: parsed.data.domains.filter(({ domain }) => configured.has(domain)),
      reservedLocalParts: settings.mailbox_policy.reservedLocalParts };
  }
  return { perUserLimit: settings.mailbox_policy.perUserLimit,
    domains: settings.domains.list.filter((entry) => entry.public).map(({ domain, perUserLimit }) => ({ domain, perUserLimit })),
    reservedLocalParts: settings.mailbox_policy.reservedLocalParts };
}

export async function loadMailboxPolicyUser(db: Db, userId: number): Promise<MailboxPolicyUser> {
  const user = await db.select({ id: users.id, role: users.role, status: users.status,
    mailboxPolicy: users.mailboxPolicy, mailboxPolicyRevision: users.mailboxPolicyRevision })
    .from(users).where(eq(users.id, userId)).get();
  if (!user) throw new AppError('not_found', '用户不存在');
  if (user.status !== 'active') throw new AppError('user_disabled', '用户已被禁用');
  return user;
}
