import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startModelPlugin } from '../adapters/free-model/service.mjs';
import { saveConfig, readConfig, publicConfig } from '../src/web/config.mjs';

test('managed source routes tools and images, filters paid models and protects local control', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-model-plugin-'));
  const realFetch = globalThis.fetch;
  const upstream = [];
  globalThis.fetch = async (url, init) => {
    if (new URL(url).hostname === '127.0.0.1') return realFetch(url, init);
    if (String(url).endsWith('/models')) return Response.json({ data: String(url).includes('kilo')
      ? [{ id: 'test/free', isFree: true, architecture: { input_modalities: ['image'] } }, { id: 'test/paid', isFree: false }]
      : [{ id: 'mimo-v2.5-free' }, { id: 'paid-model' }] });
    upstream.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response('data: '+JSON.stringify({id:'fixture',choices:[{delta:{content:'ok',tool_calls:[{index:0,id:'call-fixture',type:'function',function:{name:'inspect',arguments:'{"ok":true}'}}]},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n', { headers: {'content-type':'text/event-stream'} });
  };
  const plugin = await startModelPlugin({root});
  t.after(async () => { globalThis.fetch = realFetch; await plugin.close(); await fs.rm(root, {recursive:true,force:true}); });
  const request = (route, body, auth = true) => realFetch(plugin.descriptor.baseUrl + route, {method: body ? 'POST':'GET',headers:{...(auth ? {authorization:`Bearer ${plugin.descriptor.apiKey}`} : {}),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await request('/studio/status',undefined,false)).status,401);
  assert.equal((await request('/admin')).status,404);
  for (const source of ['opencode','kilo']) {
    const listing = await (await request('/studio/models',{source})).json();
    assert.equal(listing.models.length,1);
    assert.ok(listing.models[0].id.startsWith(source+'/'));
    const response = await request('/v1/chat/completions',{model:listing.models[0].id,messages:[{role:'user',content:[{type:'text',text:'Inspect'},{type:'image_url',image_url:{url:'data:image/png;base64,YQ=='}}]}],tools:[{type:'function',function:{name:'inspect',parameters:{type:'object',properties:{ok:{type:'boolean'}}}}}],stream:false});
    const body = await response.json();
    assert.equal(response.status,200,JSON.stringify(body));
    assert.equal(body.choices[0].message.content,'ok');
    assert.equal(body.choices[0].message.tool_calls[0].function.name,'inspect');
    assert.ok(JSON.stringify(upstream.at(-1).body).includes('data:image/png;base64,YQ=='));
    assert.ok(upstream.at(-1).body.tools.some(tool=>tool.function?.name==='inspect'));
  }
  assert.ok(upstream[0].url.includes('opencode'));
  assert.ok(upstream[1].url.includes('kilo'));
  assert.equal((await request('/studio/models',{source:'eac'})).status,400);
  assert.equal((await request('/v1/chat/completions',{model:'eac/private',messages:[]})).status,404);
  const instanceInfo = await fs.stat(path.join(root,'model-plugin','instance.json'));
  assert.ok(instanceInfo.isFile());
  // Windows uses the user's inherited directory ACL; Node mode bits do not represent POSIX 0600 there.
  if (process.platform !== 'win32') assert.equal(instanceInfo.mode & 0o777, 0o600);
  const first = await saveConfig({expectedRevision:1,base:{source:'custom',baseUrl:'https://example.invalid/v1',apiKey:'private-fixture',model:'own'}},{root});
  const saved = await saveConfig({expectedRevision:first.revision,base:{source:'opencode',model:'opencode/mimo-v2.5-free'}},{root});
  assert.equal(saved.base.apiKey,'private-fixture');
  assert.ok(!JSON.stringify(publicConfig(saved)).includes('private-fixture'));
  const resolved = await readConfig({root});
  assert.equal(resolved.basic.baseUrl,plugin.descriptor.baseUrl+'/v1');
  assert.equal(resolved.basic.apiKey,plugin.descriptor.apiKey);
  await assert.rejects(saveConfig({expectedRevision:saved.revision,base:{source:'kilo',model:'opencode/mimo-v2.5-free'}},{root}),/不匹配/);
});

test('concurrent consumers share one private plugin process and stop it cleanly', async t => {
  const {ensureModelPlugin,callModelPlugin,stopModelPlugin} = await import('../src/web/model-plugin.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'studio-model-plugin-process-'));
  t.after(async()=>{await stopModelPlugin({root});await fs.rm(root,{recursive:true,force:true});});
  const connections = await Promise.all(Array.from({length:4},()=>ensureModelPlugin({root})));
  assert.equal(new Set(connections.map(value=>value.instanceId)).size,1);
  assert.notEqual(connections[0].pid,process.pid);
  const status=await callModelPlugin('status',undefined,{root});
  assert.deepEqual(status,{running:true,accounts:[],login:{status:'idle'}});
  assert.ok(!JSON.stringify(status).includes(connections[0].apiKey));
  await stopModelPlugin({root});
  for(let i=0;i<30;i++){
    try{await fs.access(path.join(root,'model-plugin','service.lock'));await new Promise(resolve=>setTimeout(resolve,20));}
    catch{break;}
  }
  assert.equal((await callModelPlugin('status',undefined,{root,start:false})).running,false);
  await assert.rejects(fs.access(path.join(root,'model-plugin','service.lock')));
});
