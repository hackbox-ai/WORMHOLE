/** Deterministic Markdown, HTML and IM notification layouts. */
export interface NotificationItem {finding_id:number;task_name?:string;current_status?:string;name:string;vulnclass:string;severity:string;summary:string;assets:string[];detail_url:string;from_status?:string;to_status?:string;}
export interface NotificationMessage {items:NotificationItem[];batch:boolean;window_minutes:number;home_url:string;}
export const severityLabel=(s:string)=>({critical:"🔴 Serious",high:"🟠 High risk",medium:"🟡 Medium risk",low:"🔵 Low risk"} as Record<string,string>)[s]??s;
export const statusLabel=(s:string)=>({pending:"Pending",in_progress:"Processing",confirmed:"Confirmed",resolved:"Processed",fixed:"Fixed",false_positive:"False positive",ignored:"Ignore",duplicate:"Repeat",risk_accepted:"Risk Acceptance"} as Record<string,string>)[s]??s;
export const itemTitle=(it:NotificationItem)=>it.name||it.vulnclass||"(Unnamed vulnerability)";
export const statusChange=(it:NotificationItem)=>!!(it.from_status||it.to_status);
export function truncateRunes(s:string,max:number):string{const r=Array.from(s);return max<=0||r.length<=max?s:max<=1?r.slice(0,max).join(''):r.slice(0,max-1).join('')+'…';}
export function truncateBytes(s:string,max:number):string{const b=Buffer.from(s);if(max<=0||b.length<=max)return s;const suffix=max>=3?'…':'';let cut=max-Buffer.byteLength(suffix);while(cut>0&&(b[cut]!&0xc0)===0x80)cut--;return b.subarray(0,cut).toString()+suffix;}
export const oneLine=(s:string,max=0)=>truncateRunes(s.trim().split(/\s+/u).filter(Boolean).join(' '),max);
export const assetLine=(a:string[],limit=3)=>a.length>limit&&limit>0?a.slice(0,limit).join('、')+` etc. ${a.length} indivual`:a.join('、');
export const markdownText=(s:string,max=0)=>oneLine(s,max).replace(/[\\`*_\[\]()!#>|~]/g,'\\$&');
export const htmlEscape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
export const htmlEscapeAttr=(s:string)=>htmlEscape(s).replaceAll('"','&quot;');
export function truncateHTML(s:string,max:number):string{if(max<=0||Array.from(s).length<=max)return s;let cut=truncateRunes(s,max);const lt=cut.lastIndexOf('<');if(lt>=0&&!cut.slice(lt).includes('>'))cut=cut.slice(0,lt);const amp=cut.lastIndexOf('&');if(amp>=0&&!cut.slice(amp).includes(';'))cut=cut.slice(0,amp);return cut;}
export function packCount(items:NotificationItem[],max:number,reserve:number,footer:string,size:(s:string)=>number,line:(it:NotificationItem,i:number)=>string):number{if(max<=0)return items.length;const budget=Math.max(0,max-reserve-size(footer));let used=0;for(let i=0;i<items.length;i++){used+=size(line(items[i]!,i));if(used>budget&&i>0)return i;}return items.length;}
export const messageTitle=(m:NotificationMessage)=>m.batch?`Vulnerability Summary · Total ${m.items.length} Article`:m.items.length?`[${severityLabel(m.items[0]!.severity)}] ${oneLine(itemTitle(m.items[0]!))}`:"Vulnerability Notification";
const severityOrder=['critical','high','medium','low'];
export function batchIntro(m:NotificationMessage,items:NotificationItem[],total:number):string{
  let text=m.window_minutes>0?`**Recently ${m.window_minutes} Minutes added ${total} vulnerabilities**`:`**New ${total} vulnerabilities**`;
  if(total>items.length)text+=`(Before this article is displayed ${items.length} Article, the rest ${total-items.length} will continue in the next message)`;
  const parts=severityOrder.map(s=>{const n=items.filter(it=>it.severity===s).length;return n?`${severityLabel(s)} ${n}`:'';}).filter(Boolean);if(parts.length)text+='\n'+parts.join(' · ');return text+'\n\n';
}
function writeItem(it:NotificationItem,prefix:string,single:boolean):string{
  let line=`${prefix}**${severityLabel(it.severity)} · ${markdownText(itemTitle(it))}**`;
  if(!single){const extra=[];if(it.assets.length)extra.push(markdownText(assetLine(it.assets)));if(it.summary)extra.push(markdownText(it.summary,60));if(extra.length)line+=' — '+extra.join(' · ');return line+'\n';}
  line+='\n';if(statusChange(it))line+=`**Status Change**:${markdownText(statusLabel(it.from_status??''))} → ${markdownText(statusLabel(it.to_status??''))}\n`;
  if(it.vulnclass&&it.vulnclass!==itemTitle(it))line+=`**Type**:${markdownText(it.vulnclass)}\n`;
  if(it.assets.length)line+=`**Asset**:${markdownText(assetLine(it.assets))}\n`;
  if(it.summary){const s=markdownText(it.summary,120);if(s)line+=`**Abstract**:${s}\n`;}
  if(it.detail_url)line+=`[View details](${it.detail_url})\n`;return line;
}
export function markdownBody(m:NotificationMessage,max:number):{text:string;kept:number}{
  if(!m.batch)return {text:m.items.length?truncateBytes(writeItem(m.items[0]!,'',true),max):'',kept:m.items.length?1:0};
  const footer=m.home_url?`
[View all in platform](${m.home_url})\n`:'';
  const kept=packCount(m.items,max,320,footer,s=>Buffer.byteLength(s),(it,i)=>writeItem(it,`${i+1}. `,false));
  return {text:truncateBytes(batchIntro(m,m.items.slice(0,kept),m.items.length)+m.items.slice(0,kept).map((it,i)=>writeItem(it,`${i+1}. `,false)).join('')+footer,max),kept};
}
const feishuLine=(it:NotificationItem,i:number)=>`**${i+1}. ${severityLabel(it.severity)} · ${markdownText(itemTitle(it))}**`+(it.assets.length?' — '+markdownText(assetLine(it.assets)):'');
const div=(text:string)=>({tag:'div',text:{tag:'lark_md',content:text}});
const button=(label:string,url:string)=>({tag:'action',actions:[{tag:'button',text:{tag:'lark_md',content:label},url,type:'primary'}]});
export function feishuCard(m:NotificationMessage):{card:Record<string,unknown>;kept:number}{
  const elements:unknown[]=[];let kept=0;
  if(m.batch){kept=packCount(m.items,24000,320,'',s=>Buffer.byteLength(s),feishuLine);elements.push(div(batchIntro(m,m.items.slice(0,kept),m.items.length)));m.items.slice(0,kept).forEach((it,i)=>elements.push(div(feishuLine(it,i))));if(m.home_url)elements.push(button("View all in platform",m.home_url));}
  else if(m.items.length){kept=1;const it=m.items[0]!;let text=`**${severityLabel(it.severity)} · ${markdownText(itemTitle(it))}**`;if(statusChange(it))text+=`
**Status Change**:${markdownText(statusLabel(it.from_status??''))} → ${markdownText(statusLabel(it.to_status??''))}`;if(it.vulnclass&&it.vulnclass!==itemTitle(it))text+="\n**Type**:"+markdownText(it.vulnclass);if(it.assets.length)text+="\n**Asset**:"+markdownText(assetLine(it.assets));if(it.summary){const s=markdownText(it.summary,120);if(s)text+="\n**Abstract**:"+s;}elements.push(div(text));if(it.detail_url)elements.push(button("View details",it.detail_url));}
  const header:Record<string,unknown>={title:{tag:'plain_text',content:messageTitle(m)}};
  if(m.items.length)header.template=({critical:'red',high:'orange',medium:'yellow',low:'blue'} as Record<string,string>)[m.items[0]!.severity]??'grey';
  return {card:{config:{wide_screen_mode:true},header,elements},kept};
}
const telegramLine=(it:NotificationItem,i:number)=>`${i+1}. ${severityLabel(it.severity)} · ${itemTitle(it)}`+(it.assets.length?' — '+assetLine(it.assets):'');
export function telegramHTML(m:NotificationMessage):{text:string;kept:number}{
  let text='<b>'+htmlEscape(messageTitle(m))+'</b>\n';
  if(m.batch){const footer=m.home_url?`\n\n<a href="${htmlEscapeAttr(m.home_url)}">View all in platform</a>`:'';const kept=packCount(m.items,4096,160,footer,s=>Array.from(s).length,telegramLine);let title=`Vulnerability Summary · Total ${m.items.length} Article`;if(m.items.length>kept)title+=`(before displaying ${kept} Article, the rest ${m.items.length-kept} Continued under the next article)`;if(m.window_minutes>0)title=`Near ${m.window_minutes} minutes · ${title}`;return {text:truncateHTML('<b>'+htmlEscape(title)+'</b>'+m.items.slice(0,kept).map((it,i)=>'\n'+htmlEscape(telegramLine(it,i))).join('')+footer,4096),kept};}
  if(!m.items.length)return {text,kept:0};const it=m.items[0]!;
  if(statusChange(it))text+=`
<b>Status change</b>:${htmlEscape(statusLabel(it.from_status??''))} → ${htmlEscape(statusLabel(it.to_status??''))}`;
  if(it.vulnclass&&it.vulnclass!==itemTitle(it))text+="\n<b>Type</b>:"+htmlEscape(it.vulnclass);
  if(it.assets.length)text+="\n<b>Asset</b>:"+htmlEscape(assetLine(it.assets));
  const summary=oneLine(it.summary,120);if(summary)text+="\n<b>Abstract</b>:"+htmlEscape(summary);
  if(it.detail_url)text+=`\n\n<a href="${htmlEscapeAttr(it.detail_url)}">View details</a>`;
  return {text:truncateHTML(text,4096),kept:1};
}
const color=(s:string)=>({critical:'#d32029',high:'#e8830c',medium:'#d4b106',low:'#1677ff'} as Record<string,string>)[s]??'#8c8c8c';
function htmlItem(it:NotificationItem,full:boolean):string{
  let text=full?`<div style="border-left:4px solid ${color(it.severity)};padding:8px 0 8px 12px;margin-bottom:12px;">`:`<div style="border-left:3px solid ${color(it.severity)};padding:4px 0 4px 10px;margin-bottom:8px;">`;
  text+=`<div style="font-weight:600;">${htmlEscape(severityLabel(it.severity))} &middot; ${htmlEscape(itemTitle(it))}</div>`;
  if(!full){const extra=[];if(it.assets.length)extra.push(htmlEscape(assetLine(it.assets)));if(it.summary)extra.push(htmlEscape(oneLine(it.summary,60)));if(extra.length)text+=`<div style="color:#595959;font-size:13px;">${extra.join(' &middot; ')}</div>`;return text+'</div>';}
  if(statusChange(it))text+=`<div><b>Status change</b>:${htmlEscape(statusLabel(it.from_status??''))} → ${htmlEscape(statusLabel(it.to_status??''))}</div>`;
  if(it.task_name)text+=`<div><b>Task</b>:${htmlEscape(it.task_name)}</div>`;
  if(it.current_status)text+=`<div><b>Status</b>:${htmlEscape(statusLabel(it.current_status))}</div>`;
  if(it.vulnclass&&it.vulnclass!==itemTitle(it))text+=`<div><b>Type</b>:${htmlEscape(it.vulnclass)}</div>`;
  if(it.assets.length)text+=`<div><b>Assets</b>:${htmlEscape(assetLine(it.assets))}</div>`;
  const summary=oneLine(it.summary,120);if(summary)text+=`<div><b>Summary</b>:${htmlEscape(summary)}</div>`;
  if(it.detail_url)text+=`<div style="margin-top:6px;"><a href="${htmlEscapeAttr(it.detail_url)}" style="color:#1677ff;">View details</a></div>`;return text+'</div>';
}
export function htmlBody(m:NotificationMessage,max=0):string{
  let text=`<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;color:#262626;line-height:1.6;">`;
  if(m.batch){text+=`<h2 style="font-size:16px;margin:0 0 4px;">${m.window_minutes>0?"Near "+m.window_minutes+" Minutes added":"New"} ${m.items.length} vulnerabilities</h2>`;const parts=severityOrder.map(s=>{const n=m.items.filter(it=>it.severity===s).length;return n?`<span style="color:${color(s)};font-weight:600;">${htmlEscape(severityLabel(s))} ${n}</span>`:'';}).filter(Boolean);if(parts.length)text+=`<p style="margin:0 0 12px;">${parts.join(' &middot; ')}</p>`;text+=m.items.map(it=>htmlItem(it,false)).join('');}
  else if(m.items.length)text+=htmlItem(m.items[0]!,true);
  if(m.home_url)text+=`<p style="margin:16px 0 0;"><a href="${htmlEscapeAttr(m.home_url)}" style="color:#1677ff;">View all in the platform</a></p>`;return truncateHTML(text+'</div>',max);
}
