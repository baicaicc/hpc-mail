import { describe, expect, it, vi } from 'vitest';
import { registerShellServiceWorker } from './service-worker';

function fakeWindow({ serviceWorker = true, readyState = 'loading', idle = true } = {}) {
  const register = vi.fn(async () => ({}));
  const listeners = new Map<string, () => void>();
  const scope = {
    navigator: serviceWorker ? { serviceWorker: { register } } : {},
    document: { readyState },
    addEventListener: vi.fn((type: string, listener: () => void) => listeners.set(type, listener)),
    requestIdleCallback: idle ? vi.fn((callback: () => void) => callback()) : undefined,
    setTimeout: vi.fn((callback: () => void) => callback()),
  };
  return { scope: scope as unknown as Window & typeof globalThis, register, listeners, raw: scope };
}

describe('registerShellServiceWorker', () => {
  it('开发构建不注册', () => {
    const { scope, register, raw } = fakeWindow();
    expect(registerShellServiceWorker(false, scope)).toBe(false);
    expect(raw.addEventListener).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('不支持 Service Worker（含非安全上下文）时不注册', () => {
    const { scope, raw } = fakeWindow({ serviceWorker: false });
    expect(registerShellServiceWorker(true, scope)).toBe(false);
    expect(raw.addEventListener).not.toHaveBeenCalled();
  });

  it('生产构建在 load 之后的空闲时间注册 /sw.js', () => {
    const { scope, register, listeners, raw } = fakeWindow();
    expect(registerShellServiceWorker(true, scope)).toBe(true);
    expect(register).not.toHaveBeenCalled();
    listeners.get('load')!();
    expect(raw.requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 5_000 });
    expect(register).toHaveBeenCalledWith('/sw.js');
  });

  it('load 已发生时直接排到空闲时间；没有 requestIdleCallback 时延后注册', () => {
    const { scope, register, raw } = fakeWindow({ readyState: 'complete', idle: false });
    registerShellServiceWorker(true, scope);
    expect(raw.addEventListener).not.toHaveBeenCalled();
    expect(raw.setTimeout).toHaveBeenCalledWith(expect.any(Function), 1_000);
    expect(register).toHaveBeenCalledWith('/sw.js');
  });

  it('注册失败静默', async () => {
    const { scope, register, listeners } = fakeWindow();
    register.mockRejectedValueOnce(new Error('blocked'));
    registerShellServiceWorker(true, scope);
    listeners.get('load')!();
    await Promise.resolve();
    expect(register).toHaveBeenCalledTimes(1);
  });
});
