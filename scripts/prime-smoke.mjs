#!/usr/bin/env node
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const client=new Client({name:'t3-prime-smoke',version:'0.2.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[join(root,'dist/server.js')],stderr:'pipe'});
// Do not mirror raw subprocess logs or tool results: histories may contain private data.
transport.stderr?.on('data',()=>{});
async function call(name,args={}) {
  const result=await client.callTool({name,arguments:args},undefined,{timeout:65000});
  if(result.isError)throw new Error(`Tool ${name} failed; inspect locally with the CLI.`);
  return JSON.parse(result.content[0].text);
}
try {
  await client.connect(transport);
  const tools=(await client.listTools()).tools;
  assert.equal(tools.length,7);
  assert.ok(!tools.some(t=>/approval|delete|create_thread/.test(t.name)));
  const status=await call('t3_status');assert.equal(status.runtime.reachable,true);
  const list=await call('list_threads',{limit:3});assert.ok(list.threads.length>0);
  const thread=await call('get_thread',{threadId:list.threads[0].threadId,limit:3});assert.ok(thread.messages.length);
  const m=thread.messages[0];assert.ok(m.messageId);
  const chunk=await call('get_message',{threadId:m.threadId,messageId:m.messageId,maxChars:100});
  assert.ok(chunk.message.text.length<=100);
  const query=m.text.match(/\p{L}{4,}/u)?.[0] ?? m.text.trim().slice(0,20);
  assert.ok(query);
  const hits=await call('search_messages',{query,threadId:m.threadId,limit:2,snippetChars:120});
  assert.ok(hits.matches.length);assert.ok(hits.matches.every(m=>m.text.length<=120&&m.messageId));
  const grouped=await call('search_messages',{query,groupByThread:true,limit:3,snippetChars:160});
  assert.ok(grouped.matches.length);
  assert.equal(new Set(grouped.matches.map(m=>m.threadId)).size,grouped.matches.length);
  assert.ok(grouped.matches.every(m=>m.hitCount>=1&&m.state&&m.messageId));
  console.log('PASS MCP initialize + 7 tools + live status + list + bounded read + content search + grouped search');
} finally { await client.close(); }
