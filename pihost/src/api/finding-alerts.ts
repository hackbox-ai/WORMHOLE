import type {IncomingMessage,ServerResponse} from 'node:http';
import {readFileSync} from 'node:fs';
import {authKeyPath} from '../auth/service.ts';
import {FindingAlerts} from '../domains/notify/alerts.ts';
import type {AppContext} from './server.ts';
const feeds=new WeakMap<object,FindingAlerts>();
export async function routeFindingAlerts(req:IncomingMessage,res:ServerResponse,url:URL,ctx:AppContext,json:(r:ServerResponse,s:number,v:unknown)=>void){
 if(url.pathname!=='/api/alerts/findings')return false;
 if(req.method!=='GET'){json(res,405,{error:"Only supports read reminders"});return true;}
 res.setHeader('Cache-Control','no-store');let feed=feeds.get(ctx);
 if(!feed){feed=new FindingAlerts(ctx.pool,readFileSync(authKeyPath(ctx.config.dataDir)));feeds.set(ctx,feed);}
 json(res,200,await feed.feed(url.searchParams.get('cursor')??undefined));return true;
}
