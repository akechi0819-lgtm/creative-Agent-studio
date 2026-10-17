import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readCompanyConfig, saveCompanyConfig, publicCompanyConfig } from '../src/company/config.mjs';
import { readCompanyDeployment, validateCompanyServices } from '../src/company/deployment.mjs';
import { configureCompanyServices } from './helpers/company-services.mjs';
async function fixture(t) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'company-config-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const file=await configureCompanyServices(t,root);return {root,file};
}
test('company endpoints come from the bundle; personal account writes are CAS protected and never return secrets',async t=>{
 const {root}=await fixture(t);const initial=await readCompanyConfig({root});assert.equal(initial.deploymentConfigured,true);
 const first=await saveCompanyConfig({expectedRevision:1,teedy:{username:'colleague',password:'private-fixture-password'}},{root});
 assert.equal(first.teedy.baseUrl,'https://library.fixture.test');assert.equal(Object.hasOwn(first,'canvas'),false);
 const visible=publicCompanyConfig(first);assert.equal(visible.teedy.passwordConfigured,true);assert.equal(Object.hasOwn(visible,'canvas'),false);assert.doesNotMatch(JSON.stringify(visible),/private-fixture-password/);
 const second=await saveCompanyConfig({expectedRevision:2,teedy:{password:''}},{root});assert.equal(second.teedy.password,first.teedy.password);
 await assert.rejects(saveCompanyConfig({expectedRevision:2},{root}),{code:'ERR_COMPANY_CONFIG_REVISION_CONFLICT'});
 const cleared=await saveCompanyConfig({expectedRevision:3,clearSecrets:['teedy.password']},{root});assert.equal(cleared.teedy.password,'');
 if(process.platform!=='win32')assert.equal((await fs.stat(path.join(root,'config/company.json'))).mode&0o777,0o600);
});
test('staff cannot override the fixed Teedy endpoint or silently reuse a password for another account',async t=>{
 const {root}=await fixture(t);await saveCompanyConfig({expectedRevision:1,teedy:{username:'one',password:'fixture-password'}},{root});
 for(const value of [{canvas:{webUrl:'https://other.fixture.test'}},{teedy:{baseUrl:'https://other.fixture.test'}},{clearSecrets:['canvas.token']}])await assert.rejects(saveCompanyConfig({expectedRevision:2,...value},{root}));
 await assert.rejects(saveCompanyConfig({expectedRevision:2,teedy:{username:'two'}},{root}),{code:'ERR_COMPANY_CONFIG_SECRET_CONTEXT'});
 const changed=await saveCompanyConfig({expectedRevision:2,teedy:{username:'two',password:'new-fixture-password'}},{root});assert.equal(changed.teedy.username,'two');
});
test('changing an administrator-provisioned service never sends the old service password to the new origin',async t=>{
 const {root,file}=await fixture(t);await saveCompanyConfig({expectedRevision:1,teedy:{username:'one',password:'fixture-password'}},{root});
 await fs.writeFile(file,JSON.stringify({schemaVersion:1,teedy:{baseUrl:'https://new.fixture.test'}}));
 const read=await readCompanyConfig({root});assert.equal(read.teedy.password,'');assert.equal(read.teedy.baseUrl,'https://new.fixture.test');
});
test('deployment requires only one credential-free Teedy HTTPS endpoint; missing provisioning cannot save staff credentials',async t=>{
 const {root,file}=await fixture(t);
 for(const value of [{schemaVersion:1,teedy:{baseUrl:'http://local'}},{schemaVersion:1,teedy:{baseUrl:'https://user:secret@fixture.test'}},{schemaVersion:1,teedy:{baseUrl:'https://library.fixture.test',password:'secret'}},{schemaVersion:1,teedy:{baseUrl:'https://library.fixture.test'},canvas:{webUrl:'https://canvas.fixture.test'}}])assert.throws(()=>validateCompanyServices(value));
 assert.deepEqual(validateCompanyServices({schemaVersion:1,teedy:{baseUrl:'https://library.fixture.test'}}),{schemaVersion:1,teedy:{baseUrl:'https://library.fixture.test'}});
 await fs.rm(file);assert.equal((await readCompanyDeployment()).configured,false);
 await assert.rejects(saveCompanyConfig({expectedRevision:1,teedy:{username:'one',password:'fixture-password'}},{root}),{code:'ERR_COMPANY_DEPLOYMENT_REQUIRED'});
});
test('company private configuration rejects a directory escape',async t=>{
 if(process.platform==='win32')return;
 const {root}=await fixture(t);const outside=await fs.mkdtemp(path.join(os.tmpdir(),'company-outside-'));t.after(()=>fs.rm(outside,{recursive:true,force:true}));
 await fs.symlink(outside,path.join(root,'config'));await assert.rejects(readCompanyConfig({root}),{code:'ERR_COMPANY_CONFIG_PATH'});
});
