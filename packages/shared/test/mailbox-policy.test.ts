import { describe, expect, it } from 'vitest';
import { updateUserRequestSchema, userMailboxPolicySchema } from '../src/index.js';

describe('用户专属邮箱权限契约', () => {
  it('归一化域名，支持不限和空域名白名单', () => {
    expect(userMailboxPolicySchema.parse({ perUserLimit: 0, domains: [{ domain: ' Private.Example ', perUserLimit: 0 }] }))
      .toEqual({ perUserLimit: 0, domains: [{ domain: 'private.example', perUserLimit: 0 }] });
    expect(userMailboxPolicySchema.safeParse({ perUserLimit: 1, domains: [] }).success).toBe(true);
  });
  it('拒绝归一化后重复域名、非法域名与非法额度', () => {
    expect(userMailboxPolicySchema.safeParse({ perUserLimit: 1,
      domains: [{ domain: 'A.example', perUserLimit: 1 }, { domain: 'a.example', perUserLimit: 1 }] }).success).toBe(false);
    for (const value of [-1, 0.5, 10001, '3', null]) {
      expect(userMailboxPolicySchema.safeParse({ perUserLimit: value, domains: [] }).success).toBe(false);
      expect(userMailboxPolicySchema.safeParse({ perUserLimit: 1, domains: [{ domain: 'a.example', perUserLimit: value }] }).success).toBe(false);
    }
    expect(userMailboxPolicySchema.safeParse({ perUserLimit: 1, domains: [{ domain: 'not-a-domain', perUserLimit: 1 }] }).success).toBe(false);
    expect(userMailboxPolicySchema.safeParse({ perUserLimit: 1,
      domains: Array.from({ length: 65 }, (_, index) => ({ domain: `d${index}.example`, perUserLimit: 0 })) }).success).toBe(false);
  });
  it('权限保存与恢复公共配置均需要版本，旧用户更新契约保持可用', () => {
    for (const mailboxPolicy of [null, { perUserLimit: 5, domains: [] }]) {
      expect(updateUserRequestSchema.safeParse({ mailboxPolicy }).success).toBe(false);
      expect(updateUserRequestSchema.safeParse({ mailboxPolicy, expectedMailboxPolicyRevision: 0 }).success).toBe(true);
    }
    expect(updateUserRequestSchema.safeParse({ role: 'user' }).success).toBe(true);
    expect(updateUserRequestSchema.safeParse({ expectedMailboxPolicyRevision: 0 }).success).toBe(false);
  });
});
