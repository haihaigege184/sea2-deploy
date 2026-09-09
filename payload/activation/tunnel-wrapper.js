'use strict';
// pm2 托管的隧道守护：cloudflared 崩溃自动重启，域名变更自动刷新并重启激活服务器
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const DOMAIN_FILE = path.join(DIR, 'tunnel_domain.txt');
const LOG = path.join(DIR, 'tunnel.log');
let cf = null, lastDomain = '';
function log(m){ fs.appendFileSync(LOG, '[pm2 '+new Date().toISOString()+'] '+m+'\n'); }
function start(){
  if (cf) try { cf.kill(); } catch(e){}
  log('启动 cloudflared...');
  cf = spawn('/usr/local/bin/cloudflared', ['tunnel','--url','http://127.0.0.1:3457','--no-autoupdate'], { stdio:['ignore','pipe','pipe'] });
  let buf='';
  const onData=(d)=>{ buf+=d.toString(); fs.appendFileSync(LOG, d.toString()); const m=buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); if(m && m[0]!==lastDomain){ lastDomain=m[0]; fs.writeFileSync(DOMAIN_FILE, m[0]); log('新域名: '+m[0]); execFile('bash',['-c','pm2 set sea1-activation env.PUBLIC_BASE_URL="'+m[0]+'" && pm2 restart sea1-activation'], (e)=>{ if(e) log('restart err '+e.message); }); } };
  cf.stdout.on('data', onData); cf.stderr.on('data', onData);
  cf.on('exit', (c,s)=>{ log('cloudflared 退出 code='+c+' sig='+s+' 3s 后重启'); setTimeout(start, 3000); });
}
start();
process.on('SIGTERM', ()=>{ if(cf) cf.kill(); process.exit(0); });
