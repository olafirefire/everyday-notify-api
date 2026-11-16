import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';
import webpush from 'web-push';

const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:true},max:4,connectionTimeoutMillis:10000});
const site=process.env.WEB_ORIGIN||'https://everyday-mobile-preview.onrender.com';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tokenRe=/^[A-Za-z0-9_-]{40,160}$/;
if(process.env.VAPID_PUBLIC_KEY&&process.env.VAPID_PRIVATE_KEY)webpush.setVapidDetails(site,process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY);
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const subKey=Buffer.from(process.env.SUBSCRIPTION_KEY||'','base64url');
if(subKey.length!==32)console.warn('Subscription encryption key is not configured');
function seal(s){const iv=crypto.randomBytes(12);const cipher=crypto.createCipheriv('aes-256-gcm',subKey,iv);const data=Buffer.concat([cipher.update(JSON.stringify(s),'utf8'),cipher.final()]);return {iv:iv.toString('base64url'),tag:cipher.getAuthTag().toString('base64url'),data:data.toString('base64url')}}
function unseal(s){const dec=crypto.createDecipheriv('aes-256-gcm',subKey,Buffer.from(s.iv,'base64url'));dec.setAuthTag(Buffer.from(s.tag,'base64url'));return JSON.parse(Buffer.concat([dec.update(Buffer.from(s.data,'base64url')),dec.final()]).toString('utf8'))}
function send(res,status,data){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':site,'Vary':'Origin','Access-Control-Allow-Headers':'content-type,x-device-id,x-device-token','Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS'});res.end(status===204?'':JSON.stringify(data))}
async function body(req){let s='';for await(const chunk of req){s+=chunk;if(s.length>32768)throw Error('Too large')}return s?JSON.parse(s):{}}
function subscriptionOK(s){if(!s||typeof s.endpoint!=='string'||s.endpoint.length>2048||typeof s.keys?.auth!=='string'||typeof s.keys?.p256dh!=='string')return false;try{const u=new URL(s.endpoint);return u.protocol==='https:'&&!u.username&&!u.password&&/^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|push\.services\.mozilla\.com)$/.test(u.hostname)}catch{return false}}
async function device(req){const id=req.headers['x-device-id'],tok=req.headers['x-device-token'];if(!uuid.test(id||'')||!tokenRe.test(tok||''))throw Error('Unauthorized');const {rows}=await pool.query('SELECT device_id,subscription FROM everyday_devices WHERE device_id=$1 AND token_hash=$2 AND revoked_at IS NULL',[id,sha(tok)]);if(!rows.length)throw Error('Unauthorized');return rows[0]}
function parseDate(s){if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(s))return null;const t=Date.parse(s);return Number.isFinite(t)&&t>Date.now()-120000&&t<Date.now()+366*86400000?new Date(t).toISOString():null}
async function route(req,res){
 if(req.method==='OPTIONS')return send(res,204,{});
 if(req.method==='GET'&&req.url==='/health')return send(res,200,{ok:true,ready:Boolean(process.env.DATABASE_URL&&process.env.VAPID_PUBLIC_KEY&&process.env.VAPID_PRIVATE_KEY&&subKey.length===32),mode:'pilot',alwaysOn:false});
 if(req.method==='GET'&&req.url==='/api/key')return process.env.VAPID_PUBLIC_KEY?send(res,200,{publicKey:process.env.VAPID_PUBLIC_KEY}):send(res,503,{error:'Background push setup is pending'});
 if(req.headers.origin&&req.headers.origin!==site)return send(res,403,{error:'Origin rejected'});if(!process.env.DATABASE_URL||subKey.length!==32)return send(res,503,{error:'Background push setup is pending'});
 if(req.method==='POST'&&req.url==='/api/device'){
  const b=await body(req);if(!uuid.test(b.id||'')||!tokenRe.test(b.token||'')||!subscriptionOK(b.subscription))return send(res,400,{error:'Invalid subscription'});
  const {rows}=await pool.query("INSERT INTO everyday_devices(device_id,token_hash,subscription) VALUES($1,$2,$3::jsonb) ON CONFLICT(device_id) DO UPDATE SET subscription=EXCLUDED.subscription,updated_at=now(),revoked_at=NULL WHERE everyday_devices.token_hash=EXCLUDED.token_hash RETURNING device_id",[b.id,sha(b.token),JSON.stringify(seal(b.subscription))]);
  return send(res,rows.length?200:403,rows.length?{ok:true}:{error:'Already registered'});
 }
 const d=await device(req);
 if(req.method==='POST'&&req.url==='/api/jobs'){
  const b=await body(req);if(!uuid.test(b.itemId||'')||!Array.isArray(b.alerts)||b.alerts.length>6)return send(res,400,{error:'Invalid reminder'});
  const times=b.alerts.map(parseDate);if(times.some(t=>t===null))return send(res,400,{error:'Invalid reminder date'});
  const client=await pool.connect();try{
   await client.query('BEGIN');
   await client.query("UPDATE everyday_reminder_jobs SET status='cancelled' WHERE device_id=$1 AND item_id=$2 AND status IN ('pending','processing','failed')",[d.device_id,b.itemId]);
   for(const t of [...new Set(times)])await client.query("INSERT INTO everyday_reminder_jobs(device_id,item_id,fire_at,status) VALUES($1,$2,$3,'pending') ON CONFLICT(device_id,item_id,fire_at) DO UPDATE SET status='pending',attempts=0,retry_at=NULL,delivered_at=NULL",[d.device_id,b.itemId,t]);
   await client.query('COMMIT');return send(res,200,{ok:true,scheduled:times.length})
  }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
 }
 if(req.method==='POST'&&req.url==='/api/test'){
  try{await webpush.sendNotification(unseal(d.subscription),JSON.stringify({id:'',kind:'test'}),{TTL:300,urgency:'high'});return send(res,200,{ok:true})}catch(e){return send(res,502,{error:'Push provider rejected',status:e.statusCode||null})}
 }
 if(req.method==='DELETE'&&req.url==='/api/device'){await pool.query('DELETE FROM everyday_devices WHERE device_id=$1',[d.device_id]);return send(res,200,{ok:true})}
 return send(res,404,{error:'Not found'})
}
http.createServer((req,res)=>{route(req,res).catch(e=>{console.error(e.message);send(res,e.message==='Unauthorized'?401:500,{error:e.message==='Unauthorized'?'Unauthorized':'Service unavailable'})})}).listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('Everyday notifications API ready'));