#!/usr/bin/env bash
# 本地部署：步骤与 .github/workflows/deploy.yml 一致（参数校验 → 测试/类型检查/审计 → 构建 → 注入资源配置
# → dry-run → D1 书签 → 迁移 → deploy → jwt_secret → 迁移校验 → 引导管理员 → 等待生效 → 线上冒烟），
# 供没有配置 GitHub Actions 的自部署用 wrangler 已有登录发布。不支持 reset_database。
#
# 用法: HPC_DEPLOY_ENV=/path/to/deploy.env scripts/deploy-local.sh [--dry-run-only]
# deploy.env（私有，0600，不入库）提供与工作流相同的 Secrets / Variables：
#   CLOUDFLARE_ACCOUNT_ID D1_DATABASE_ID KV_NAMESPACE_ID CUSTOM_DOMAIN ADMIN_USERNAME ADMIN_PASSWORD JWT_SECRET
# 可选：
#   PLACEMENT_REGION           同工作流 Variable
#   ADMIN_TOTP_SECRET          管理员已开 2FA 时，冒烟用它计算登录码
#   CLOUDFLARE_API_TOKEN_CMD   每次调用 wrangler 前执行，stdout 作为 CLOUDFLARE_API_TOKEN（用于借用短期令牌）；
#                              不设则使用本机 wrangler login
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORKER="$ROOT/apps/worker"
D1_NAME=hpc-cloud-mail-db
DRY_RUN_ONLY=false
[ "${1:-}" = "--dry-run-only" ] && DRY_RUN_ONLY=true

: "${HPC_DEPLOY_ENV:?需要 HPC_DEPLOY_ENV 指向私有 deploy.env}"
set -a
# shellcheck disable=SC1090
. "$HPC_DEPLOY_ENV"
set +a

fail() { echo "部署失败: $1" >&2; exit 1; }
step() { echo; echo "== $1"; }

# 每次调用前取令牌：借用的 OAuth 令牌有效期短，长流程中途会过期
wrangler_auth() {
  if [ -n "${CLOUDFLARE_API_TOKEN_CMD:-}" ]; then
    CLOUDFLARE_API_TOKEN=$(bash -c "$CLOUDFLARE_API_TOKEN_CMD") || fail '取 Cloudflare 令牌失败'
    export CLOUDFLARE_API_TOKEN
  fi
}
wr() { wrangler_auth; (cd "$WORKER" && npx wrangler "$@"); }

step '校验部署参数'
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || fail '缺 CLOUDFLARE_ACCOUNT_ID'
[ -n "${D1_DATABASE_ID:-}" ] || fail '缺 D1_DATABASE_ID'
[ -n "${KV_NAMESPACE_ID:-}" ] || fail '缺 KV_NAMESPACE_ID'
[ -n "${CUSTOM_DOMAIN:-}" ] || fail '缺 CUSTOM_DOMAIN'
echo "${JWT_SECRET:-}" | grep -qE '^[A-Za-z0-9_-]{43,}$' || fail 'JWT_SECRET 需为 43+ 位 URL-safe 字符串'
plen=${#ADMIN_PASSWORD}
[ "$plen" -ge 12 ] && [ "$plen" -le 128 ] || fail 'ADMIN_PASSWORD 需 12-128 位'
echo "${ADMIN_USERNAME:-}" | grep -qE '^[a-z0-9][a-z0-9_-]{2,31}$' || fail 'ADMIN_USERNAME 非法'
export CLOUDFLARE_ACCOUNT_ID
cd "$ROOT"
git diff --quiet HEAD -- || fail '工作区有未提交改动；部署版本必须对应一个提交'
BUILD_SHA=$(git rev-parse HEAD)
echo "build sha: $BUILD_SHA"

step '安装依赖'
pnpm install --frozen-lockfile

step 'shared / web / worker 测试、类型检查与构建'
pnpm --filter @hpc-mail/shared test
pnpm --filter @hpc-mail/shared typecheck
pnpm --filter @hpc-mail/web test
pnpm --filter @hpc-mail/web typecheck
pnpm --filter @hpc-mail/web build
maps=$(find apps/web/dist -name '*.map' | wc -l)
[ "$maps" = "0" ] || fail '产物包含 sourcemap'
pnpm --filter @hpc-mail/worker build:assets
pnpm --filter @hpc-mail/worker test
pnpm --filter @hpc-mail/worker typecheck

step '依赖安全审计'
pnpm audit --prod --audit-level high

step '注入 Cloudflare 资源配置（结束时还原 wrangler.toml）'
trap 'git -C "$ROOT" checkout -- apps/worker/wrangler.toml' EXIT
(
  cd "$WORKER"
  sed -i.bak \
    -e "s/__D1_DATABASE_ID__/${D1_DATABASE_ID}/" \
    -e "s/__KV_NAMESPACE_ID__/${KV_NAMESPACE_ID}/" \
    -e "s|site_origin = \"https://hpc.email\"|site_origin = \"https://${CUSTOM_DOMAIN}\"|" \
    -e "s|build_sha = \"local\"|build_sha = \"${BUILD_SHA}\"|" \
    -e "s|^workers_dev = true$|workers_dev = false\nroutes = [ { pattern = \"${CUSTOM_DOMAIN}\", custom_domain = true } ]|" \
    wrangler.toml
  rm -f wrangler.toml.bak
  grep -qE '__[A-Z0-9_]+__' wrangler.toml && fail 'wrangler.toml 仍有未注入占位符' || true
  grep -q 'workers_dev = false' wrangler.toml || fail 'routes/workers_dev 注入失败'
  if [ -n "${PLACEMENT_REGION:-}" ]; then
    echo "$PLACEMENT_REGION" | grep -qE '^[a-z0-9]+:[a-z0-9-]+$' || fail 'PLACEMENT_REGION 格式非法'
    printf '\n[placement]\nregion = "%s"\n' "$PLACEMENT_REGION" >> wrangler.toml
  fi
  node scripts/inject-asset-routes.mjs
  rules=$(grep -E '^run_worker_first' wrangler.toml | grep -o '"[^"]*"' | wc -l)
  [ "$rules" -le 100 ] || fail 'run_worker_first 超过 Cloudflare 100 条上限'
  grep -E '^run_worker_first' wrangler.toml | grep -q '"/assets/\*"' || fail 'run_worker_first 缺少 /assets/* 兜底规则'
)

step '部署预演（dry-run）'
wr deploy --dry-run
if $DRY_RUN_ONLY; then echo; echo 'dry-run 通过（--dry-run-only，未写入云端）'; exit 0; fi

step '记录 D1 回滚书签'
wr d1 time-travel info "$D1_NAME" --json | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const m = s.match(/"bookmark"\s*:\s*"([^"]+)"/);
    if (!m) { console.error("未能取得 D1 Time Travel bookmark"); process.exit(1); }
    console.log("D1 rollback bookmark: " + m[1]);
  });'

step '应用数据库迁移'
wr d1 migrations apply "$D1_NAME" --remote

step '部署 Worker'
wr deploy

step '同步 Worker secrets'
wrangler_auth
printf '%s' "$JWT_SECRET" | (cd "$WORKER" && npx wrangler secret put jwt_secret)

step '校验迁移完整性'
expected=$(ls "$WORKER"/migrations/*.sql | wc -l)
applied=$(wr d1 execute "$D1_NAME" --remote --json --command 'SELECT COUNT(*) AS c FROM d1_migrations' | jq '.[0].results[0].c')
echo "migrations: 代码 $expected / 线上 $applied"
[ "$expected" = "$applied" ] || fail '线上迁移数与代码不一致'

step '引导管理员账号（幂等）'
wrangler_auth
node apps/worker/scripts/seed-admin.mjs

step '等待新版本全球生效'
BASE_URL="https://${CUSTOM_DOMAIN}"
live=false
for i in $(seq 1 24); do
  if curl -sS -D /tmp/hpc-config.headers.$$ "$BASE_URL/api/config" | jq -e '.data.registrationMode' >/dev/null 2>&1 \
    && tr -d '\r' < /tmp/hpc-config.headers.$$ | grep -qi "^x-hpc-build: $BUILD_SHA$"; then
    echo "新版本已生效（第 $i 次探测）"; live=true; break
  fi
  echo "等待部署传播…（$i/24）"
  sleep 10
done
rm -f /tmp/hpc-config.headers.$$
$live || fail '240s 内新版本未生效'

step '线上冒烟'
ADMIN_TOTP=""
if [ -n "${ADMIN_TOTP_SECRET:-}" ]; then
  ADMIN_TOTP=$(node "$ROOT/scripts/totp-code.mjs")
fi
BASE_URL="$BASE_URL" ADMIN_TOTP="$ADMIN_TOTP" bash scripts/smoke.sh
