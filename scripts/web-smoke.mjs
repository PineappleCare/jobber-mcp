// Built stdio MCP discovery only. No OAuth, browser session, model or business requests.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const reads=['preview_invoice_payment','preview_property_map_pin','get_web_operation','jobber_web_status'];
const writes=['record_invoice_payment','update_property_map_pin'];
for(const readonly of [true,false]){
 const home=await mkdtemp(path.join(os.tmpdir(),'jobber-web-smoke-'));
 const child=spawn(process.execPath,['build/index.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,TRANSPORT:'stdio',JOBBER_WEB_ENABLED:'true',JOBBER_READ_ONLY:String(readonly),JOBBER_WRITE_CAPABILITIES:'web_payments,web_properties',JOBBER_STATE_DIR:home,ENCRYPTION_KEY:'1'.repeat(64),JOBBER_CLIENT_ID:'fixture',JOBBER_CLIENT_SECRET:'fixture'},stdio:['pipe','pipe','pipe']});
 let buffer='';const pending=new Map();let seq=0;
 child.stdout.on('data',chunk=>{buffer+=chunk;const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines){try{const msg=JSON.parse(line);pending.get(msg.id)?.(msg);}catch{}}});
 const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>reject(Error('Discovery timeout')),10000);pending.set(id,msg=>{clearTimeout(timer);pending.delete(id);resolve(msg);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 try{
  await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'web-fixture',version:'1'}});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const list=(await rpc('tools/list')).result.tools;
  for(const name of reads)if(!list.find(t=>t.name===name&&t.annotations?.readOnlyHint===true))throw Error('Missing browser read '+name);
  for(const name of writes){const tool=list.find(t=>t.name===name);if(readonly){if(tool)throw Error('Write exposed under read-only');}else{if(tool?.annotations?.readOnlyHint!==false||!tool.inputSchema.properties.proposal.properties.target_id||!tool.inputSchema.properties.proposal.properties.account_id)throw Error('Incomplete write contract '+name);}}
  console.log(JSON.stringify({read_only:readonly,web_reads:reads.length,web_writes:readonly?0:2,exact_proposal_schema:'passed',business_calls:0}));
 }finally{child.kill();await once(child,'exit');await rm(home,{recursive:true,force:true});}
}
