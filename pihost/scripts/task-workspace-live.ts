/** Read-only check of deployed task workspace. No task/tool/approval mutations. */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {chromium} from 'playwright-core';
import {loadConfig} from '../src/config.ts';
import {AuthService,authKeyPath} from '../src/auth/service.ts';
process.env.WORMHOLE_CONFIG='/var/lib/wormhole/config.json';
const config=loadConfig(),pool=new Pool({connectionString:config.database.dsn});
const token=await new AuthService(pool,authKeyPath(config.dataDir)).signTokenForTest(300);
const base='http://127.0.0.1:18887',output='/tmp/wormhole-task-workspace-live';
const response=await fetch(base+'/api/tasks',{headers:{Authorization:`Bearer ${token}`}});
assert.equal(response.status,200);const tasks=(await response.json() as any).tasks;
const task=tasks.find((task:any)=>task.status==='done')??tasks[0];assert.ok(task);
await mkdir(output,{recursive:true});
const browser=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome',headless:true,args:['--no-sandbox']});
try {
  const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'});
  await context.addInitScript(value=>localStorage.setItem('wormhole_token',value),token);
  await context.addCookies([{name:'wormhole_token',value:token,url:base}]);
  const page=await context.newPage(),errors:string[]=[],writes:string[]=[],results:any[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/**',async route=>{if(route.request().method()!=='GET'){writes.push(route.request().method()+' '+new URL(route.request().url()).pathname);await route.abort();}else await route.continue();});
  const font=await readFile('/tmp/wormhole-studio-qa-font.ttc');await page.route('**/_qa/font',route=>route.fulfill({contentType:'font/collection',body:font}));
  const style=async()=>{await page.addStyleTag({content:'@font-face{font-family:TaskQA;src:url("/_qa/font")}body,button,input,textarea,select{font-family:TaskQA,Arial,sans-serif!important}'});await page.evaluate(()=>document.fonts.ready);};
  for(const mode of ['light','dark']) {
    await context.addCookies([{name:'theme_mode',value:mode,url:base}]);
    await page.goto(base+'/function/tasks/detail/?id='+task.id,{waitUntil:'domcontentloaded'});
    await page.locator('.task-session-history').waitFor();await style();
    await page.waitForFunction(mode=>document.documentElement.classList.contains('dark')===(mode==='dark'),mode);
    assert.match(await page.locator('.task-session-history').evaluate(el=>getComputedStyle(el).backdropFilter),/blur/);
    assert.ok(await page.locator('.task-view-nav').evaluate(el=>el.scrollWidth<=el.clientWidth));
    assert.equal(await page.getByText("Task workspace",{exact:true}).count(),0);
    await page.screenshot({path:output+'/sessions-'+mode+'.png'});
    await page.getByRole('tab',{name:"Overlay view",exact:true}).click();await page.locator('.coverage-tree-scroll').waitFor();
    const tree=page.locator('.coverage-tree-scroll');await tree.locator('.asset-tree-node').first().waitFor({timeout:15000}).catch(()=>{});
    assert.equal(await tree.getAttribute('data-growth-direction'),'vertical');
    assert.ok(await tree.evaluate(el=>el.scrollWidth<=el.clientWidth));
    await page.screenshot({path:output+'/coverage-'+mode+'.png'});
    await page.getByRole('tab',{name:"Execution path",exact:true}).click();await page.getByRole('button',{name:"Node index",exact:true}).click();
    await page.getByRole('textbox',{name:"Search execution node",exact:true}).waitFor();
    await page.screenshot({path:output+'/path-'+mode+'.png'});
    await page.getByRole('tab',{name:"Real-time dynamics",exact:true}).click();await page.locator('.task-activity-workspace').waitFor();
    await page.locator('.task-activity-card').first().waitFor({timeout:15000}).catch(()=>{});
    await page.screenshot({path:output+'/activity-'+mode+'.png'});
    results.push({mode,taskId:task.id,activityCards:await page.locator('.task-activity-card').count()});
  }
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('combobox',{name:"Task View",exact:true}).selectOption('coverage');await page.locator('.coverage-tree-scroll').waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:output+'/mobile.png'});
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
  await writeFile(output+'/result.json',JSON.stringify({status:'PASS',results,browserErrors:errors,blockedMutations:writes},null,2));
  console.log('deployed task workspace light/dark/mobile PASS; zero mutations/errors');
  await context.close();
} finally {await browser.close();await pool.end();}
