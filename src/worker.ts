#!/usr/bin/env node
import { PrimeService } from './prime.js';
import { WorkflowService } from './workflow.js';
import { ThreadStore } from './store.js';
let stopping=false, failed=false;
process.on('SIGTERM',()=>{stopping=true;});
process.on('SIGINT',()=>{stopping=true;});
// Reopen configuration each tick. No model work is scheduled without an explicit event.
while(!stopping) {
  let store:ThreadStore|undefined,service:WorkflowService|undefined;
  try {
    store=new ThreadStore(); service=new WorkflowService(new PrimeService(store));
    const result=await service.call('deliver_pending',{limit:3});
    if(failed) { console.log('Delivery worker recovered.'); failed=false; }
    if(result.delivered) console.log(JSON.stringify({at:new Date().toISOString(),delivered:result.delivered}));
  } catch {
    if(!failed) console.error('Delivery unavailable; messages retained. Diagnose with t3-mcp-prime delivery_status and t3_status. Check instance binding, token configuration and local database access. Repeated failures are suppressed until recovery.');
    failed=true;
  }
  finally { service?.close(); store?.close(); }
  for(let i=0;i<15&&!stopping;i++) await new Promise(r=>setTimeout(r,1000));
}
