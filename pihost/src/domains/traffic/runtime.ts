import {taskNetworkScope} from '../network/context.ts';
import path from 'node:path';
import type {SettingsConsumers} from '../settings/consumers.ts';
import {TrafficStore} from './store.ts';
import {TrafficProxy,type ScopedTrafficPolicy} from './proxy.ts';
export class TrafficRuntime {
  readonly store:TrafficStore;readonly proxy:TrafficProxy;
  constructor(dir:string,private readonly settings:SettingsConsumers){this.store=new TrafficStore(path.join(dir,'traffic'));this.proxy=new TrafficProxy(this.store);}
  async start(){this.applySettings();await this.proxy.start();}
  applySettings(){this.proxy.setUpstream(this.settings.get().globalProxy);}
  enabled(){return this.settings.get().trafficCapture&&this.proxy.isRunning();}
  route(){return{capture:this.enabled()?this.store:undefined,proxy:this.enabled()?this.proxy.address():this.settings.get().globalProxy,caFile:this.enabled()?this.proxy.caFile:''};}
  async browserProxy(authorize: ScopedTrafficPolicy["authorize"], context: ScopedTrafficPolicy["context"], humanBrowser=false){
    const scope=await taskNetworkScope(context.taskId,humanBrowser);
    if(scope?.mode==='jump'&&!scope.upstream)throw new Error("Springboard browser channel is unavailable");
    const proxy = new TrafficProxy(this.store,0,{authorize:async(url,method,connect)=>{await scope?.authorize?.(url);return authorize(url,method,connect);},context,strictTLS:scope?.mode==='jump',capture:()=>this.enabled()});
    proxy.setUpstream(scope?.upstream??this.settings.get().globalProxy);
    return proxy;
  }
  async close(){await this.proxy.stop();this.store.close();}
}
