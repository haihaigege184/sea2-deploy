#!/usr/bin/env bash
# 渲染仿真测试：模板 → 渲染 → JSON 解析 + 结构断言 + 占位符校验
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$REPO/_rendertest_work"
rm -rf "$WORK"
mkdir -p "$WORK"
cd "$WORK"

source "$REPO/lib/common.sh"
source "$REPO/lib/platform.sh"
source "$REPO/lib/render.sh"

# ---- 模拟向导赋值 ----
MAIN_QQ=111111111; BACKUP_QQ=222222222; ADMIN_QQ=333333333; PRINT_GROUP=444444444
NOTIFY_GROUPS_JSON='["444444444"]'; QL_WHITELIST_JSON='[]'; PRINTERS_JSON='["HP_Test"]'
PRINTER_DEFAULT="HP_Test"; DEMO_MODE_JSON='{"444444444": true}'
NAPCAT_TOKEN=testtoken0123456789abcdef; SEA2_WS_TOKEN=wstoken0123456789abcdef
WEBUI_TOKEN=webuitoken1234; SEA2_DEVICE_ID=$(printf 'a%.0s' $(seq 64))
SEA2_OPS_TOKEN=ops0123456789abcdef; WEB_ADMIN_TOKEN=webadmin0123456789
MONITOR_TOKEN=$(printf 'b%.0s' $(seq 64)); LICENSE_ADMIN_TOKEN=$(printf 'c%.0s' $(seq 64))
BOT_NOTIFY_TOKEN=$(printf 'd%.0s' $(seq 64)); WEBHOOK_SECRET=$(printf 'e%.0s' $(seq 48))
SEA2_DEPLOY_TOKEN=$(printf 'f%.0s' $(seq 64)); DOCKER_MGR_PASS=dm1234567890
INSTALL_TIME=2026-09-09T00:00:00Z
CENTRAL_SERVER=http://127.0.0.1:3457; SEA1_ADMIN_TOKEN=admintoken0123456789abcdef

# ---- 组装部署树 ----
TPL="$REPO/templates"
mkdir -p sea2/napcat sea1 act appnap/config appnap2/config
cp "$TPL/sea2.config.json.tmpl"   sea2/config.json
cp "$TPL/sea1.config.json.tmpl"   sea1/config.json
cp "$TPL/activation.config.env"   act/config.env
cp "$TPL/ops.env"                 sea2/napcat/ops.env
cp "$TPL/napcat-http.env"         sea2/napcat/napcat-http.env
cp "$TPL/ecosystem.sea2-bot.config.js"         sea2/ecosystem.sea2-bot.config.js
cp "$TPL/ecosystem.watchdog.config.js"         sea2/watchdog.eco.js
cp "$TPL/onebot11.main.json"      appnap/config/onebot11_${MAIN_QQ}.json
cp "$TPL/webui.main.json"         appnap/config/webui.json
cp "$TPL/onebot11.backup.json"    appnap2/config/onebot11_${BACKUP_QQ}.json
cp "$TPL/webui.backup.json"       appnap2/config/webui.json

# ---- 渲染 + 校验 ----
render_tree sea2; render_tree sea1; render_tree act
render_tree appnap/config; render_tree appnap2/config
verify_no_placeholder sea2; verify_no_placeholder sea1; verify_no_placeholder act
verify_no_placeholder appnap; verify_no_placeholder appnap2
echo "[PASS] 渲染完整（无占位符残留）"

# ---- payload 同树渲染演练（真实安装路径：payload 代码一起渲染） ----
cp -r "$REPO/payload" payload_t
render_tree payload_t
verify_no_placeholder payload_t
echo "[PASS] payload 全树渲染通过"

# ---- JSON/结构断言（python） ----
WPATH="$(cygpath -w "$WORK" 2>/dev/null || echo "$WORK")"
PYTHONUTF8=1 python - "$WPATH" <<'PYEOF'
import json, io, sys, os
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
W = sys.argv[1]
for f in ['sea2/config.json','sea1/config.json',
          'appnap/config/onebot11_111111111.json','appnap/config/webui.json',
          'appnap2/config/onebot11_222222222.json','appnap2/config/webui.json']:
    json.load(open(os.path.join(W,f), encoding='utf-8')); print('JSON OK:', f)
cfg = json.load(open(os.path.join(W,'sea2/config.json'), encoding='utf-8'))
assert cfg['superAdmin']=='333333333' and cfg['notify_groups']==['444444444']
assert cfg['demo_mode']=={'444444444': True} and cfg['napcat_token']=='testtoken0123456789abcdef'
assert len(cfg['license']['monitorToken'])==64 and cfg['ql_notify_whitelist']==[]
assert cfg['printer']['default']=='HP_Test'
c1 = json.load(open(os.path.join(W,'sea1/config.json'), encoding='utf-8'))
assert c1['napcat_port']==3000 and c1['ws_port']==9092
assert c1['license']['licensePath']=='/root/sea2/license.json'
assert c1['license']['machineIdPath']=='/root/sea2/config/machine-id'
ob = json.load(open(os.path.join(W,'appnap/config/onebot11_111111111.json'), encoding='utf-8'))
assert ob['network']['httpServers'][0]['port']==4000
assert ob['network']['websocketClients'][0]['url'].endswith(':9093/api/bot/qqws')
assert ob['network']['websocketClients'][0]['token']=='wstoken0123456789abcdef'
obd = json.load(open(os.path.join(W,'appnap2/config/onebot11_222222222.json'), encoding='utf-8'))
assert len(obd['network']['websocketClients'])==2
assert obd['network']['websocketClients'][0]['url'].endswith('127.0.0.1:9092/api/bot/qqws')
assert obd['network']['websocketClients'][1]['url'].endswith('127.0.0.1:9093/api/bot/qqws')
w1 = json.load(open(os.path.join(W,'appnap/config/webui.json'), encoding='utf-8'))
assert w1['autoLoginAccount']=='111111111' and w1['port']==6100
w2 = json.load(open(os.path.join(W,'appnap2/config/webui.json'), encoding='utf-8'))
assert w2['autoLoginAccount']=='222222222' and w2['port']==6099
env = open(os.path.join(W,'act/config.env'), encoding='utf-8').read()
assert 'testtoken0123456789abcdef' not in env
assert 'ops0123456789abcdef' in env and 'PORT="3457"' in env
ops = open(os.path.join(W,'sea2/napcat/ops.env'), encoding='utf-8').read()
assert 'ops0123456789abcdef' in ops and 'testtoken0123456789abcdef' in ops
print('全部结构断言通过')
PYEOF
echo "=== 渲染仿真测试全部通过 ==="
rm -rf "$WORK"
