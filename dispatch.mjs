import pg from 'pg';
import crypto from 'node:crypto';
import webpush from 'web-push';
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:true},max:3,connectionTimeoutMillis:10000});
webpush.setVapidDetails(process.env.WEB_ORIGIN||'https://everyday-mobile-preview.onrender.com',process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY);
async function dispatch(){
 const db=await pool.connect();
 let due;
 try{
  await db.query('BEGIN');
  const {rows}=await db.query("WITH claim AS (SELECT job_id FROM everyday_reminder_jobs WHERE (status='pending' AND fire_at<=now() AND (retry_at IS NULL OR retry_at<=now())) OR (status='processing' AND claimed_at<now()-interval '5 minutes') ORDER BY fire_at LIMIT 50 FOR UPDATE SKIP LOCKED) UPDATE everyday_reminder_jobs j SET status='processing',claimed_at=now(),attempts=attempts+1 FROM claim WHERE j.job_id=claim.job_id RETURNING j.job_id,j.device_id,j.item_id,j.attempts");
  due=rows;
  await db.query('COMMIT');
 }catch(e){await db.query('ROLLBACK');throw e}finally{db.release()}
 for(const job of due){
  const {rows}=await pool.query('SELECT subscription FROM everyday_devices WHERE device_id=$1 AND revoked_at IS NULL',[job.device_id]);
  if(!rows.length){await pool.query("UPDATE everyday_reminder_jobs SET status='cancelled' WHERE job_id=$1",[job.job_id]);continue}
  try{
   await webpush.sendNotification(unseal(rows[0].subscription),JSON.stringify({id:job.item_id,kind:'reminder'}),{TTL:3600,urgency:'high'});
   await pool.query("UPDATE everyday_reminder_jobs SET status='sent',delivered_at=now(),error_code=NULL WHERE job_id=$1",[job.job_id]);
   console.log('Sent job',job.job_id);
  }catch(err){
   const code=Number(err.statusCode)||0;
   if(code===404||code===410){
    await pool.query('UPDATE everyday_devices SET revoked_at=now() WHERE device_id=$1',[job.device_id]);
    await pool.query("UPDATE everyday_reminder_jobs SET status='failed',error_code=$2 WHERE job_id=$1",[job.job_id],String(code));
   }else{
    const exhausted=job.attempts>=6;
    await pool.query("UPDATE everyday_reminder_jobs SET status=$2,retry_at=now()+($3::integer * interval '1 minute'),error_code=$4 WHERE job_id=$1",[job.job_id,exhausted?'failed':'pending',Math.min(90,2**job.attempts),String(code||'network')]);
   }
   console.error('Push failed',job.job_id,code||'network');
  }
 }
 return due.length;
}
dispatch().then(count=>{console.log('Checked jobs:',count);return pool.end()}).catch(async e=>{console.error(e.message);await pool.end();process.exitCode=1});