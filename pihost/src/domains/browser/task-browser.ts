import {registerTaskResource} from '../workspace/resource-paths.ts';
import {getSetCookies,Headers as CookieHeaders} from "undici";
import {taskWebTargets} from "../tasks/targets.ts";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isIP } from "node:net";
import { access, chown, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import type { AssetsService } from "../assets/service.ts";
import type { TrafficRuntime } from "../traffic/runtime.ts";
import type { TrafficProxy } from "../traffic/proxy.ts";
import type { ToolContext } from "../tools/gate.ts";

export class BrowserTargetError extends Error {
  readonly code="BROWSER_TARGET_NOT_REGISTERED";
  readonly retryable=false;
}

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
type Identity = { origin: string; path: string; state: StorageState; expires: number };
type Tab = {id:string;page:Page;human:boolean;worker?:string;loginRequested?:boolean};
type Session = {
  name:string;shared:boolean;authLocked:boolean;tabs:Map<string,Tab>;headers:Map<string,{authorization:string;cookieHash:string}>;
  id: string;
  taskId: number;
  worker: string;
  origin: string;
  proxy: TrafficProxy;
  directories: string[];
  context: BrowserContext;
  page: Page;
  busy: boolean;
  human: boolean;
  loginRequested?: boolean;
  crawl: boolean;
  idle?: NodeJS.Timeout;
  basePath: string;
};

function webUrl(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("The browser target must be an HTTP or HTTPS address");
  return url;
}

function insidePath(url: URL, base: string) {
  if (/%(?:2f|5c|25)/i.test(url.pathname)) return false;
  return url.pathname === base || url.pathname.startsWith(base.endsWith("/") ? base : base + "/");
}

export class TaskBrowsers {
  private sessions = new Map<string, Session>();
  private workers = new Map<string,{environment:string;tab:string}>();
  private identities = new Map<number, Map<string, Identity>>();
  private starting = new Map<string, Promise<Session>>();
  private closing = new Map<number, Promise<void>>();
  private shutdownRequested = false;

  constructor(
    private readonly pool: Pool,
    private readonly traffic: TrafficRuntime,
    private readonly assets: AssetsService,
    private readonly notify: (taskId: number, message?:string) => void|Promise<void>,
  ) {}

  private async task(taskId:number,human=false) {
    const row=(await this.pool.query("SELECT * FROM tasks WHERE id=$1 AND deleted_at IS NULL",[taskId])).rows[0];
    if(!row||row.archived||!['created','running'].includes(row.status)||!human&&(row.status!=='running'||row.paused||row.queued||row.deadline_at&&new Date(row.deadline_at).getTime()<=Date.now()))throw new Error("The task is currently inoperable with the browser");
    return row;
  }
  private async allowed(taskId:number,origin:string,human=false){
    const task=await this.task(taskId,human);
    if(!taskWebTargets(task).some(target=>new URL(target).origin===origin))
      throw new BrowserTargetError("The browser target is not registered in the task, please operate within the task scope");
  }
  private find(taskId:number,id:string){
    const s=this.sessions.get(id);if(!s||s.taskId!==taskId)throw new Error("Browser environment has ended");return s;
  }
  private async open(ctx:ToolContext,url:URL,identityName?:string,name?:string){
    const taskId=ctx.taskId!,key=taskId+':'+randomUUID();
    if(this.shutdownRequested||this.closing.has(taskId))throw new Error("Task Browser is closing");
    if(this.sessions.size+this.starting.size>=3)throw new Error("The browser environment is full, please close the idle environment and try again");
    const starting=this.create(ctx,url,identityName);this.starting.set(key,starting);
    try{
      const s=await starting;
      if(this.shutdownRequested||this.closing.has(taskId)||ctx.signal?.aborted){await this.dispose(s);throw new Error("Browser launch canceled");}
      s.name=(name??'').trim().slice(0,50)||"Environment "+(this.list(taskId).length+1);
      this.sessions.set(s.id,s);this.refreshIdle(s);return s;
    }finally{this.starting.delete(key);}
  }
  private tab(s:Session,id?:string){
    const t=id?s.tabs.get(id):s.tabs.values().next().value;
    if(!t||t.page.isClosed())throw new Error("Tab is closed");return t;
  }
  private attach(s:Session,page:Page,human:boolean,worker?:string){
    const existing=[...s.tabs.values()].find(t=>t.page===page);if(existing){existing.human=human;existing.worker=worker;return existing;}
    if(s.tabs.size>=8){void page.close();throw new Error("Maximum of 8 tabs open per environment");}
    page.setDefaultTimeout(8000);page.setDefaultNavigationTimeout(15000);
    const tab:Tab={id:randomUUID(),page,human,worker};s.tabs.set(tab.id,tab);
    page.on('close',()=>s.tabs.delete(tab.id));
    page.on('request',request=>{
      const authorization=request.headers()['authorization'];
      if(!authorization||!/^https?:/.test(request.url()))return;
      void s.context.cookies(request.url()).then(cookies=>{
        if(this.sessions.has(s.id))s.headers.set(new URL(request.url()).origin,{authorization,cookieHash:this.cookieHash(cookies)});
      }).catch(()=>{});
    });
    return tab;
  }
  private cookieHash(cookies:Awaited<ReturnType<BrowserContext['cookies']>>){
    return createHash('sha256').update(JSON.stringify(cookies.map(c=>[c.name,c.value,c.domain,c.path]).sort())).digest('hex');
  }
  private async create(ctx: ToolContext, url: URL, identityName?: string): Promise<Session> {
    const taskId = ctx.taskId!;
    const origin = url.origin,environmentId=randomUUID();
    await this.allowed(taskId, origin,ctx.businessKind==='browser-human');
    const identity = identityName ? this.identities.get(taskId)?.get(identityName) : undefined;
    if (identityName && (!identity || identity.expires <= Date.now() || identity.origin !== origin || !insidePath(url, identity.path))) {
      throw new Error("The task login status has expired or does not match the access scope");
    }
    let session: Session | undefined;
    const proxy = await this.traffic.browserProxy(
      async (target, method, connect) => {
        if ((identity && (target.origin !== origin || identity.expires <= Date.now())) ||
            (!connect && identity && !insidePath(target, identity.path))) return false;
        if (session?.crawl && !["GET", "HEAD", "CONNECT"].includes(method)) return false;
        await this.allowed(taskId, target.origin,true);
        if (connect) return true;
        const host = target.hostname.replace(/^\[|\]$/g, "");
        const decision = await this.assets.evaluateCandidates(
          [["url", target.href], [isIP(host) ? "ip" : "domain", host]], taskId,
        );
        return decision.allowed && decision.reason !== "rule-read-failed(fail-open)";
      },
      { taskId, intentId: ctx.intentId, browserEnvironmentId:environmentId },
      true,
    );
    let context: BrowserContext | undefined;
    const directories: string[] = [];
    try {
      const rootHost = process.getuid?.() === 0;
      const binary = process.env.WORMHOLE_BROWSER_EXECUTABLE ||
        chromium.executablePath();
      await access(binary, constants.X_OK).catch(() => {
        throw new Error("Hosted browser runtime not installed");
      });
      const profile = await mkdtemp(path.join(tmpdir(), "wormhole-browser-profile-"));
      directories.push(profile);
      await registerTaskResource(this.pool,taskId,'runtime',profile);
      let executablePath = binary;
      if (rootHost) {
        // Playwright supervises the launcher. The browser itself runs with a
        // reduced UID and without supplementary groups from the host service.
        const launcher = await mkdtemp(path.join(tmpdir(), "wormhole-browser-launch-"));
        directories.push(launcher);
        await registerTaskResource(this.pool,taskId,'runtime',launcher);
        executablePath = path.join(launcher, "launch");
        await writeFile(executablePath,
          '#!/bin/sh\nexec /usr/bin/setpriv --reuid=65534 --regid=65534 --clear-groups --no-new-privs "$WORMHOLE_BROWSER_BIN" "$@"\n',
          { mode: 0o700 },
        );
        await chown(profile, 65534, 65534);
      }
      await proxy.start();
      context = await chromium.launchPersistentContext(profile, {
        headless: true,
        timeout: 15_000,
        executablePath,
        env: { PATH: "/usr/bin:/bin", HOME: profile, LANG: "C.UTF-8", WORMHOLE_BROWSER_BIN: binary },
        proxy: { server: proxy.address(), bypass: "<-loopback>" },
        args: ["--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
        ignoreHTTPSErrors: true,
        serviceWorkers: "block",
        acceptDownloads: false,
        viewport: { width: 1100, height: 700 },
      });
      if (identity) {
        await context.addCookies(identity.state.cookies);
        await context.addInitScript((entries) => {
          const frame = globalThis as unknown as {
            location: { origin: string };
            localStorage: { setItem(key: string, value: string): void };
          };
          for (const entry of entries) {
            if (entry.origin === frame.location.origin) {
              for (const item of entry.localStorage) frame.localStorage.setItem(item.name, item.value);
            }
          }
        }, identity.state.origins);
      }
      await context.routeWebSocket("**/*", (socket) => socket.close());
      const page = context.pages()[0] ?? await context.newPage();
      page.setDefaultTimeout(8_000);
      page.setDefaultNavigationTimeout(15_000);
      session = {
        id: environmentId, name:"",shared:ctx.businessKind!=='browser-human',authLocked:ctx.businessKind==='browser-human',tabs:new Map(),headers:new Map(),taskId, worker: ctx.businessId, origin, proxy, directories,
        context, page, busy: false, human: false, crawl: false, basePath: identity?.path ?? "/",
      };
      this.attach(session,page,ctx.businessKind==='browser-human',ctx.businessKind==='browser-human'?undefined:ctx.businessId);
      context.on('page',p=>{void p.opener().then(opener=>{
        const owner=[...session!.tabs.values()].find(t=>t.page===opener);
        if([...session!.tabs.values()].some(t=>t.page===p))return;
        try{this.attach(session!,p,owner?.human??(ctx.businessKind==='browser-human'),owner?.worker);}catch{}
      });});
      await context.route('**/*',async route=>{
        try{
          const request=route.request(),p=request.frame().page();
          const tab=[...session!.tabs.values()].find(t=>t.page===p);
          await this.allowed(taskId,new URL(request.url()).origin,tab?.human===true);
          if(session!.authLocked&&!tab?.human)throw new Error("The environment is being logged in manually");
          await route.continue();
        }catch{await route.abort('blockedbyclient').catch(()=>{});}
      });
      return session;
    } catch (error) {
      await context?.close().catch(() => {});
      await proxy.stop();
      await Promise.allSettled(directories.map((dir) => rm(dir, { recursive: true, force: true })));
      throw error;
    }
  }

  private refreshIdle(session: Session) {
    clearTimeout(session.idle);
    session.idle = setTimeout(() => {
      if (session.busy) this.refreshIdle(session);
      else void this.remove(session);
    }, 15*60_000).unref();
  }

  private async dispose(session: Session) {
    clearTimeout(session.idle);
    await Promise.allSettled([session.context.close(), session.proxy.stop()]);
    await Promise.allSettled(session.directories.map((dir) => rm(dir, { recursive: true, force: true })));
  }

  private async remove(s:Session){
    try{await this.dispose(s);}finally{
      this.sessions.delete(s.id);
      for(const [key,ref]of this.workers)if(ref.environment===s.id)this.workers.delete(key);
    }
  }
  releaseWorker(taskId:number,businessId:string){
    for(const s of this.sessions.values())if(s.taskId===taskId)for(const t of s.tabs.values())if(t.worker===businessId)t.worker=undefined;
    this.workers.delete(taskId+':'+businessId);
  }
  pauseTask(taskId:number){
    for(const s of this.sessions.values())if(s.taskId===taskId){
      for(const t of s.tabs.values())if(!t.human){
        if(s.busy&&s.page===t.page)void t.page.close().catch(()=>{});
        else{t.human=true;t.worker=undefined;t.loginRequested=false;}
      }
      for(const [key,ref]of this.workers)if(ref.environment===s.id)this.workers.delete(key);
      this.refreshIdle(s);
    }
  }
  stopTask(taskId: number): Promise<void> {
    const previous = this.closing.get(taskId);
    if (previous) return previous;
    const stop = (async () => {
      this.identities.delete(taskId);
      const sessions = [...this.sessions.values()].filter((session) => session.taskId === taskId);
      await Promise.allSettled([
        ...sessions.map((session) => this.remove(session)),
        ...[...this.starting].filter(([key]) => key.startsWith(taskId + ":")).map(([, launch]) =>
          launch.then((session) => this.dispose(session))),
      ]);
    })().finally(() => this.closing.delete(taskId));
    this.closing.set(taskId, stop);
    return stop;
  }

  async shutdown() {
    this.shutdownRequested = true;
    const tasks = new Set([...this.sessions.values()].map((session) => session.taskId));
    for (const key of this.starting.keys()) tasks.add(Number(key.split(":")[0]));
    await Promise.all([...tasks].map((taskId) => this.stopTask(taskId)));
  }

  busy(taskId:number){return this.list(taskId).length>0||[...this.starting.keys()].some(key=>key.startsWith(taskId+':'));}
  list(taskId:number){
    return [...this.sessions.values()].filter(s=>s.taskId===taskId).map(s=>({
      id:s.id,name:s.name,worker:s.worker,url:s.context.pages().find(p=>!p.isClosed())?.url()??'',
      human:[...s.tabs.values()].some(t=>t.human),loginRequested:[...s.tabs.values()].some(t=>t.loginRequested),
      shared:s.shared,authLocked:s.authLocked,
      tabs:[...s.tabs.values()].filter(t=>!t.page.isClosed()).map(t=>({id:t.id,url:t.page.url(),human:t.human,worker:t.worker??'',loginRequested:t.loginRequested===true}))
    }));
  }
  async workspace(taskId:number){
    const row=(await this.pool.query("SELECT * FROM tasks WHERE id=$1 AND deleted_at IS NULL",[taskId])).rows[0];
    if(!row)throw new Error("Task does not exist");
    return {sessions:this.list(taskId),targets:taskWebTargets(row),can_open:!row.archived&&['created','running'].includes(row.status),paused:!!row.paused,lifecycle:row.status,idle_minutes:15};
  }
  async humanOpen(taskId:number,params:Record<string,unknown>){
    await this.task(taskId,true);const url=webUrl(String(params.url));
    const s=await this.open({businessKind:'browser-human',businessId:'task-'+taskId+'-human',agentKey:'human',taskId},url,undefined,String(params.name??''));
    const t=this.tab(s);
    try{await this.performTab(s,t,'navigate',{url:url.href});}catch(e){await this.remove(s);throw e;}
    return {environment_id:s.id,tab_id:t.id,sessions:this.list(taskId)};
  }
  private async performTab(s:Session,t:Tab,action:string,params:Record<string,unknown>){
    if(s.busy)throw new Error("The browser environment is performing the operation, please try again later.");
    s.page=t.page;return {...await this.perform(s,action,params),environment_id:s.id,tab_id:t.id};
  }
  async humanAction(taskId:number,id:string,action:string,params:Record<string,unknown>){
    await this.task(taskId,true);const s=this.find(taskId,id);
    if(action==='close_environment'){await this.remove(s);return {closed:true};}
    if(action==='rename'){s.name=String(params.name??'').trim().slice(0,50)||s.name;return {name:s.name};}
    if(s.busy)throw new Error("The browser environment is performing the operation, please try again later.");
    if(action==='new_tab'){
      if(s.tabs.size>=8)throw new Error("Maximum of 8 tabs open per environment");
      const url=webUrl(String(params.url));await this.allowed(taskId,url.origin,true);
      const p=await s.context.newPage(),t=this.attach(s,p,true);
      try{return await this.performTab(s,t,'navigate',{url:url.href});}catch(e){await p.close();throw e;}
    }
    const t=this.tab(s,params.tab_id?String(params.tab_id):undefined);
    if(action==='take'||action==='release'||action==='login'){
      if(action==='take'||action==='login'){t.human=true;t.worker=undefined;}
      if(action==='login')s.authLocked=true;
      if(action==='release'){t.human=false;t.worker=undefined;t.loginRequested=false;s.authLocked=false;s.shared=true;}
      this.refreshIdle(s);return {human:t.human,authLocked:s.authLocked};
    }
    if(action==='handoff'){
      const url=webUrl(t.page.url());await this.allowed(taskId,url.origin,true);
      const saved=await this.assets.upsertSource({type:'endpoint',url:url.href,method:'GET',task_id:taskId,source:'browser',page_title:(await t.page.title()).slice(0,200)},{viaAgent:false,endpointTool:true});
      if(!saved.ok)throw new Error(saved.error??"Page clue saving failed");
      await this.notify(taskId,"User handover browser environment "+s.name+' ('+s.id+"), tab page "+t.id+", current page "+url.href+'；'+String(params.note??'').slice(0,1000)+". This environment/tab is used by task_browser; http_request can use browser_environment to reference its cookies and observed authentication headers.");
      s.shared=true;s.authLocked=false;t.human=false;t.worker=undefined;t.loginRequested=false;
      this.refreshIdle(s);return {shared:true,human:false};
    }
    if(action==='close_tab'){if(!t.human)throw new Error("Please take over the tab first");await t.page.close();return {closed:true};}
    if(action!=='screenshot'&&!t.human)throw new Error("Please take over the tab first");
    if(!['screenshot','point','type','enter','key','scroll','navigate','back','forward','reload'].includes(action))throw new Error("Unsupported operation");
    return this.performTab(s,t,action,params);
  }
  async authHeaders(ctx:ToolContext,id:string,address:string){
    if(!ctx.taskId||ctx.agentKey!=='worker'||ctx.manualInvocation)throw new Error("The authentication environment is only available to the current task Worker");
    await this.task(ctx.taskId);ctx.signal?.throwIfAborted();
    const s=this.find(ctx.taskId,id),url=webUrl(address);await this.allowed(ctx.taskId,url.origin);
    if(!s.shared||s.authLocked)throw new Error("The browser environment has not been handed over to the Agent, or manual login is in progress.");
    if(![...s.tabs.values()].some(t=>{try{return new URL(t.page.url()).origin===url.origin;}catch{return false;}}))throw new Error("Please visit the target site in this environment first");
    const cookies=await s.context.cookies(address),headers:Record<string,string>={};
    if(cookies.length)headers.cookie=cookies.map(c=>c.name+'='+c.value).join('; ');
    const auth=s.headers.get(url.origin),hash=this.cookieHash(cookies);
    if(auth?.cookieHash===hash)headers.authorization=auth.authorization;
    else if(auth)s.headers.delete(url.origin);
    return {headers,receipt:{environment_id:s.id,name:s.name,revision:createHash('sha256').update(hash+'\0'+(headers.authorization??'')).digest('hex').slice(0,12),authorization_observed:!!headers.authorization},
      acceptResponse:async(response:Record<string,unknown>)=>{
        if(!this.sessions.has(s.id))return;
        await this.task(ctx.taskId!);
        if(this.cookieHash(await s.context.cookies(address))!==hash)return;
        const values=response['set-cookie'];if(!values)return;
        const h=new CookieHeaders();for(const value of Array.isArray(values)?values:[values])h.append('set-cookie',String(value));
        for(const cookie of getSetCookies(h)){
          const domain=(cookie.domain??url.hostname).replace(/^\\./,'');
          if(url.hostname!==domain&&!url.hostname.endsWith('.'+domain))continue;
          const scopePath=cookie.path?.startsWith('/')?cookie.path:url.pathname.slice(0,url.pathname.lastIndexOf('/')+1)||'/';
          await s.context.addCookies([{name:cookie.name,value:cookie.value,domain:cookie.domain??url.hostname,path:scopePath,
            ...(cookie.maxAge!==undefined?{expires:Math.floor(Date.now()/1000)+Math.max(-1,cookie.maxAge)}:cookie.expires?{expires:Math.floor(new Date(cookie.expires).getTime()/1000)}:{}),
            httpOnly:!!cookie.httpOnly,secure:!!cookie.secure,sameSite:cookie.sameSite==='None'?'None':cookie.sameSite==='Strict'?'Strict':'Lax'}]);
        }
      }};

  }
  async execute(ctx:ToolContext,params:Record<string,unknown>){
    if(!ctx.taskId||ctx.agentKey!=='worker'||ctx.manualInvocation)throw new Error("The browser is only used for the current task Worker");
    await this.task(ctx.taskId);ctx.signal?.throwIfAborted();
    const action=String(params.action),key=ctx.taskId+':'+ctx.businessId;
    if(action==='list')return {environments:this.list(ctx.taskId)};
    let ref=this.workers.get(key),s=params.environment_id?this.find(ctx.taskId,String(params.environment_id)):ref?this.sessions.get(ref.environment):undefined;
    if(action==='new_environment')s=undefined;
    if(s&&params.identity)throw new Error("Switching to a published identity requires a new independent environment, please close the current Worker tab first");
    if(!s&&(action==='open'||action==='crawl'||action==='new_environment')){
      const url=webUrl(String(params.url));
      const reserved=[...this.sessions.values()].find(v=>v.taskId===ctx.taskId&&(!v.shared||v.authLocked)&&[...v.tabs.values()].some(t=>t.page.url().startsWith(url.origin+'/')));
      if(reserved&&action!=='new_environment')return {status:'waiting_for_user',retryable:false,environment_id:reserved.id,message:"The user is preparing the environment for this site, please wait for handover or continue other checks"};
      s=!params.identity&&action!=='new_environment'?[...this.sessions.values()].find(v=>v.taskId===ctx.taskId&&v.shared&&!v.authLocked&&[...v.tabs.values()].some(t=>t.page.url().startsWith(url.origin+'/'))):undefined;
      if(!s)s=await this.open(ctx,url,params.identity?String(params.identity):undefined,String(params.name??''));
    }
    if(!s)throw new Error("Please list to select the environment first, or open the browser");
    if(!s.shared||s.authLocked)return {status:'waiting_for_user',retryable:false,environment_id:s.id,message:"The environment is being manually operated or logged in, please continue other independent checks and wait for the handover notification"};
    let t=params.tab_id?this.tab(s,String(params.tab_id)):ref&&ref.environment===s.id?s.tabs.get(ref.tab):undefined;
    if(action==='new_tab')t=undefined;
    if(action==='new_tab'||!t){
      if(action!=='new_tab')t=[...s.tabs.values()].find(tab=>!tab.human&&(!tab.worker||tab.worker===ctx.businessId)&&!tab.page.isClosed());
      if(!t){if(s.tabs.size>=8)throw new Error("Maximum of 8 tabs open per environment");t=this.attach(s,await s.context.newPage(),false,ctx.businessId);}
    }
    if(t.human||t.worker&&t.worker!==ctx.businessId)return {status:'waiting_for_user',retryable:false,environment_id:s.id,tab_id:t.id,message:"The tab is operated by the user or other Worker, please select an idle tab"};
    if(s.busy)throw new Error("The browser environment is performing an operation");
    t.worker=ctx.businessId;this.workers.set(key,{environment:s.id,tab:t.id});
    if(action==='close'||action==='close_tab'){await t.page.close();this.workers.delete(key);return {closed:true};}
    if(action==='request_login'){
      t.loginRequested=true;s.authLocked=true;const deadline=Date.now()+90000;
      try{while(t.loginRequested&&this.sessions.has(s.id)&&Date.now()<deadline)await delay(250,undefined,{signal:ctx.signal});
        return {login_handoff:t.loginRequested?'timed_out':'returned',environment_id:s.id,tab_id:t.id};
      }finally{t.loginRequested=false;}
    }
    s.page=t.page;
    const cancel=()=>{if(!t!.human)void t!.page.close().catch(()=>{});};ctx.signal?.addEventListener('abort',cancel,{once:true});
    try{
      ctx.signal?.throwIfAborted();
      if(action==='crawl'){s.busy=true;s.crawl=true;try{return {...await this.crawl(s,ctx,String(params.url),Number(params.limit??5)),environment_id:s.id,tab_id:t.id};}finally{s.busy=false;s.crawl=false;this.refreshIdle(s);}}
      if(action==='publish_auth'){s.busy=true;try{return await this.publish(s,String(params.identity??''),String(params.path??'/'));}finally{s.busy=false;this.refreshIdle(s);}}
      return await this.performTab(s,t,action==='new_tab'||action==='new_environment'?'navigate':action,params);
    }finally{ctx.signal?.removeEventListener('abort',cancel);}
  }

  private async perform(session: Session, action: string, params: Record<string, unknown>) {
    session.busy = true;
    this.refreshIdle(session);
    const page = session.page;
    try {
      if (action === "open" || action === "navigate") {
        const url = webUrl(String(params.url));
        await this.allowed(session.taskId,url.origin,[...session.tabs.values()].find(t=>t.page===page)?.human===true);
        if(!insidePath(url,session.basePath))throw new Error("Target is not within environment path range");
        await page.goto(url.href, { waitUntil: "domcontentloaded" });
      } else if(action==='back')await page.goBack({waitUntil:'domcontentloaded'});
      else if(action==='forward')await page.goForward({waitUntil:'domcontentloaded'});
      else if(action==='reload')await page.reload({waitUntil:'domcontentloaded'});
      else if(action==='scroll')await page.mouse.wheel(Math.max(-1500,Math.min(1500,Number(params.x)||0)),Math.max(-1500,Math.min(1500,Number(params.y)||0)));
      else if(action==='key'){
        const key=String(params.key);if(!['Tab','Shift+Tab','Enter','Backspace','Delete','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown','ControlOrMeta+A'].includes(key))throw new Error("Unsupported keys");
        await page.keyboard.press(key);
      } else if (action === "click") await page.locator(String(params.selector)).click();
      else if (action === "fill") await page.locator(String(params.selector)).fill(String(params.text ?? "").slice(0, 4096));
      else if (action === "point") {
        const x = Number(params.x), y = Number(params.y);
        if (!(x >= 0 && x < 1100 && y >= 0 && y < 700)) throw new Error("Coordinates exceed browser viewport");
        await page.mouse.click(x, y);
      } else if (action === "type") await page.keyboard.insertText(String(params.text ?? "").slice(0, 4096));
      else if (action === "enter") await page.keyboard.press("Enter");
      else if (action === "screenshot") {
        const jpeg = await page.screenshot({ type: "jpeg", quality: 70, timeout: 8_000 });
        return { url: page.url(), image: jpeg.toString("base64"), width: 1100, height: 700 };
      } else if (action !== "snapshot") throw new Error("Unsupported browser operation");
      return { url: page.url(), snapshot: (await page.locator("body").ariaSnapshot()).slice(0, 12_000) };
    } finally {
      session.busy = false;
    }
  }

  private async publish(session: Session, name: string, path: string) {
    if (!/^[\p{L}\p{N}_-]{1,50}$/u.test(name) || !path.startsWith("/") || path.includes("?") || path.includes("#") || path.includes("\\")) {
      throw new Error("Please enter the account ID and application path");
    }
    const url = webUrl(session.page.url());
    if (url.origin !== session.origin || !insidePath(url, path) || !insidePath(url, session.basePath) ||
        !insidePath(new URL(session.origin + path), session.basePath)) {
      throw new Error("The login state path must cover the current page and be within the scope of the current session");
    }
    const state = await session.context.storageState();
    const host = url.hostname;
    state.cookies = state.cookies.filter((cookie) => cookie.domain.replace(/^\./, "") === host);
    state.origins = state.origins.filter((entry) => entry.origin === session.origin);
    if (!state.cookies.length && !state.origins.some((entry) => entry.localStorage.length)) throw new Error("The current page has not yet obtained the login status");
    if (Buffer.byteLength(JSON.stringify(state)) > 256 * 1024) throw new Error("The login status exceeds the upper limit of saving");
    let accounts = this.identities.get(session.taskId);
    if (!accounts) this.identities.set(session.taskId, accounts = new Map());
    if (accounts.size >= 8 && !accounts.has(name)) throw new Error("The number of task login states has reached the upper limit");
    accounts.set(name, { origin: session.origin, path, state, expires: Date.now() + 30 * 60_000 });
    return { identity: name, origin: session.origin, path };
  }

  private async crawl(session: Session, ctx: ToolContext, initial: string, requested: number) {
    const limit = Number.isSafeInteger(requested) ? Math.max(1, Math.min(10, requested)) : 5;
    const first = webUrl(initial);
    if (first.origin !== session.origin || !insidePath(first, session.basePath)) throw new Error("Reconnaissance entry is outside the scope of the current session");
    const queue = [first.href], visited = new Set<string>();
    const results: { url: string; asset_id: number; status: number }[] = [];
    while (queue.length && visited.size < limit) {
      ctx.signal?.throwIfAborted();
      if (ctx.canExecute && !await ctx.canExecute()) throw new Error("Task execution has stopped");
      const url = queue.shift()!;
      if (visited.has(url)) continue;
      visited.add(url);
      const response = await session.page.goto(url, { waitUntil: "domcontentloaded" });
      if (!response || response.status() >= 400) continue;
      const endpoint = webUrl(session.page.url());
      if (endpoint.origin !== session.origin || !insidePath(endpoint, session.basePath)) continue;
      const names = [...new Set(endpoint.searchParams.keys())];
      endpoint.search = ""; endpoint.hash = "";
      const saved = await this.assets.upsertSource({
        type: "endpoint", url: endpoint.href, method: "GET", source: "agent",
        task_id: session.taskId, owner_node_id: ctx.intentId, status_code: response.status(),
        params: names.map((name) => ({ name, in: "query" })),
      }, { viaAgent: true, endpointTool: true });
      if (saved.ok && saved.asset) {
        results.push({ url: endpoint.href, asset_id: Number(saved.asset.id), status: response.status() });
        this.notify(session.taskId);
      }
      const links = await session.page.locator("a[href]").evaluateAll((items) =>
        items.slice(0, 50).map((item) => (item as unknown as { href: string }).href),
      );
      for (const href of links) {
        try {
          const link = webUrl(href);
          link.search = ""; link.hash = "";
          if (link.origin === session.origin && insidePath(link, session.basePath) &&
              !/(?:logout|signout|delete|remove|reset)/i.test(link.pathname) &&
              !visited.has(link.href) && !queue.includes(link.href) && queue.length < 50) queue.push(link.href);
        } catch { /* Ignore non-web links. */ }
      }
    }
    return { visited: visited.size, endpoints: results };
  }
}
