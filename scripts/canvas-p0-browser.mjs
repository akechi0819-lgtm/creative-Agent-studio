import { chromium } from 'playwright';
import { connection, dataRoot, health } from '../src/canvas/client.mjs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
const config=await connection();
const marker=process.env.P0_BROWSER_COMPLETION_MARKER || 'dsh-tool-complete';
const screenshot=process.env.P0_BROWSER_SCREENSHOT || 'docs/evidence/p0/dsh-canvas.png';
await rm(path.join(dataRoot(),marker),{force:true});
const browser=await chromium.launchPersistentContext(path.join(dataRoot(),'p0-browser'),{channel:'chrome',headless:true,viewport:{width:1440,height:1000}});
const page=browser.pages()[0] || await browser.newPage();
await page.goto(config.browserUrl,{waitUntil:'domcontentloaded'});
for(let i=0;i<100;i++){if((await health(config)).hasCanvas)break;await page.waitForTimeout(100);}
if(!(await health(config)).hasCanvas)throw new Error('独立Canvas编辑页未连接');
console.log('Independent P0 browser connected; waiting for DSH tool probe marker');
for(let i=0;i<1800;i++) {if(await readFile(path.join(dataRoot(),marker),'utf8').catch(()=>false))break;await page.waitForTimeout(1000);}
await page.screenshot({path:path.resolve(screenshot)});
await browser.close();
