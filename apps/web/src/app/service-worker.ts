/** 外壳缓存 Service Worker（public/sw.js）的注册：仅生产构建，页面 load 后的空闲时间进行，不与首屏争抢。 */
export function registerShellServiceWorker(
  prod: boolean = import.meta.env.PROD,
  scope: Window & typeof globalThis = globalThis as Window & typeof globalThis,
): boolean {
  const container = scope.navigator?.serviceWorker;
  if (!prod || !container) return false;
  const register = () => {
    container.register('/sw.js').catch(() => {
      // 注册失败不影响使用，只是少了外壳缓存
    });
  };
  const whenIdle = () => {
    if (typeof scope.requestIdleCallback === 'function') scope.requestIdleCallback(register, { timeout: 5_000 });
    else scope.setTimeout(register, 1_000);
  };
  if (scope.document.readyState === 'complete') whenIdle();
  else scope.addEventListener('load', whenIdle, { once: true });
  return true;
}
