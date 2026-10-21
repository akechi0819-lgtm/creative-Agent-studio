import assert from 'node:assert/strict';
import test from 'node:test';
import { pythonInternals } from '../src/launcher/python.mjs';

const run = (program, options) => pythonInternals.run(process.execPath, ['-e', program], { capture: true, ...options });

test('dependency progress refreshes the idle deadline beyond its initial duration', async () => {
  const result = await run(`let n=0; const t=setInterval(()=>{ process.stderr.write('downloaded '+(++n)+'\\n'); if(n===8)clearInterval(t); },180);`, { idleTimeout: 1000, timeout: 5000 });
  assert.match(result.stderr, /downloaded 8/);
});

test('dependency silence times out and reports cache-preserving retry', async () => {
  await assert.rejects(run('setInterval(()=>{},1000)', { idleTimeout: 500, timeout: 3000 }), /连续无安装输出.*下载缓存保留/);
});

test('progress cannot keep a hung dependency command alive beyond the total limit', async () => {
  await assert.rejects(run(`setInterval(()=>process.stderr.write('progress\\n'),40)`, { idleTimeout: 1000, timeout: 1800 }), /总运行时间.*下载缓存保留/);
});

test('a failed command retains its original stderr and does not become a timeout', async () => {
  await assert.rejects(run(`process.stderr.write('fixture dependency error');process.exitCode=7`, { idleTimeout: 1000, timeout: 3000 }), /退出码 7：fixture dependency error/);
});
