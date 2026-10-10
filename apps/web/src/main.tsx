import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/app/app';
import { bootPrefetch } from '@/app/boot-prefetch';
import { installChunkReloadHandler } from '@/app/chunk-reload';
import { installQueryPersistence } from '@/app/query-persistence';
import { registerShellServiceWorker } from '@/app/service-worker';
import { queryClient } from '@/lib/query-client';
import '@/styles/index.css';

document.documentElement.style.colorScheme = 'light';

installChunkReloadHandler();
// 在 React 首次渲染前恢复上次的首屏缓存，并发起首屏数据与 chunk 请求
bootPrefetch();
installQueryPersistence(queryClient);
registerShellServiceWorker();

const root = document.getElementById('root');
if (!root) throw new Error('缺少 #root 挂载点');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
