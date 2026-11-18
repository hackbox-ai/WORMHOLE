/** Frozen SQLite index, full bodies, trigram and SHA256 blobs. */
import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,existsSync,statSync,unlinkSync,renameSync} from 'node:fs';
import path from 'node:path';
import {goUTF8} from '../findings/utf8.ts';
import type {CaptureContext} from './context.ts';
export interface CapturedExchange {url:string;method:string;status:number;contentType:string;requestType:string;reqHead:string;respHead:string;reqBody:Buffer;respBody:Buffer;ts?:number;context?:CaptureContext;respStream?:{file:string;hash:string;length:number}}
const binaryTypes=['image/','audio/','video/','font/','application/octet-stream','application/zip','application/gzip','application/x-gzip','application/x-tar','application/x-7z-compressed','application/x-rar','application/pdf','application/x-msdownload','application/vnd.android.package-archive','application/java-archive','application/wasm','application/x-shockwave-flash'];
const template=(p:string)=>(p||'/').split('/').map(s=>/^\d+$/.test(s)?'{id}':/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(s)?'{uuid}':/^[\da-f]{16,}$/i.test(s)?'{hex}':/^[A-Za-z0-9_-]{24,}$/.test(s)?'{token}':s).join('/');
const utf8Clip=(b:Buffer,n:number)=>{if(b.length<=n)return b.toString('utf8');let end=n;while(end>n-4&&end>0&&(b[end]!&0xc0)===0x80)end--;return b.subarray(0,end).toString('utf8');};
type Meta={id:string;ts:number;host:string;method:string;url_template:string;url:string;status:number;content_type:string;resp_len:number;path:string};
export class TrafficStore {
  onCapture?:(id:string,x:CapturedExchange)=>void;
  hasBlob(taskId:number,hash:string){return !!this.db.prepare("SELECT 1 FROM blob_refs b JOIN exchanges e ON e.id=b.exchange_id WHERE b.hash=? AND json_extract(e.context,'$.taskId')=? LIMIT 1").get(hash,taskId);}

  pendingFlow(taskId:number){return this.db.prepare("SELECT id FROM exchanges WHERE flow_done=0 AND json_extract(context,'$.taskId')=? AND json_extract(context,'$.checkId') IS NULL AND (COALESCE(json_extract(context,'$.reverse'),0)=0 OR json_extract(context,'$.view')='plaintext') ORDER BY rowid LIMIT 100").all(taskId).map(r=>String(r.id));}
  markFlow(id:string){this.db.prepare('UPDATE exchanges SET flow_done=1 WHERE id=?').run(id);}

  receipt(requestId:string,view:string):string|undefined{return this.db.prepare("SELECT id FROM exchanges WHERE request_id=? AND json_extract(context,'$.view')=? ORDER BY ts DESC LIMIT 1").get(requestId,view)?.id as string|undefined;}
  context(id:string){const row=this.db.prepare('SELECT context FROM exchanges WHERE id=?').get(id);return row?.context?JSON.parse(String(row.context)) as CaptureContext:undefined;}

  readonly db:DatabaseSync;readonly fts:boolean;private sequence=0;private closed=false;
  constructor(readonly dir:string){
    mkdirSync(path.join(dir,'_index'),{recursive:true});mkdirSync(path.join(dir,'_blobs','sha256'),{recursive:true});
    this.db=new DatabaseSync(path.join(dir,'_index','index.sqlite'),{timeout:5000});
    this.db.exec(`PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS exchanges(id TEXT PRIMARY KEY,ts INTEGER,host TEXT,method TEXT,url_template TEXT,url TEXT,status INTEGER,content_type TEXT,req_len INTEGER,resp_len INTEGER,path TEXT);
      CREATE INDEX IF NOT EXISTS idx_ex_host ON exchanges(host); CREATE INDEX IF NOT EXISTS idx_ex_tmpl ON exchanges(host,url_template);
      CREATE INDEX IF NOT EXISTS idx_ex_ts ON exchanges(ts); CREATE INDEX IF NOT EXISTS idx_ex_status ON exchanges(status); CREATE INDEX IF NOT EXISTS idx_ex_resp ON exchanges(resp_len);
      CREATE TABLE IF NOT EXISTS exchange_bodies(id TEXT PRIMARY KEY,req_head TEXT NOT NULL DEFAULT '',req_body BLOB,req_blob TEXT,resp_head TEXT NOT NULL DEFAULT '',resp_body BLOB,resp_blob TEXT);
      CREATE TABLE IF NOT EXISTS blob_refs(hash TEXT NOT NULL,exchange_id TEXT NOT NULL,PRIMARY KEY(hash,exchange_id));
      CREATE INDEX IF NOT EXISTS idx_blob_refs_ex ON blob_refs(exchange_id);`);
    const columns=new Set((this.db.prepare('PRAGMA table_info(exchanges)').all() as {name:string}[]).map(c=>c.name));
    for(const column of ['context','request_id'])if(!columns.has(column))this.db.exec('ALTER TABLE exchanges ADD COLUMN '+column+" TEXT NOT NULL DEFAULT '"+(column==='context'?'{}':'')+"'");
    if(!columns.has('flow_done'))this.db.exec('ALTER TABLE exchanges ADD COLUMN flow_done INTEGER NOT NULL DEFAULT 0');
    this.db.exec("UPDATE exchanges SET context='{}' WHERE context=''");
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_ex_request ON exchanges(request_id)');
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_ex_task ON exchanges(json_extract(context,'$.taskId'))");
    let fts=false;try{this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS ex_fts USING fts5(content,tokenize='trigram',content='',contentless_delete=1)");fts=true;}catch(e){console.warn('[traffic] full-text index unavailable:',String(e));}this.fts=fts;
  }
  close(){if(!this.closed){this.closed=true;this.db.close();}}
  private spill(body:Buffer,type:string){
    const binary=binaryTypes.some(p=>type.trim().toLowerCase().startsWith(p))||body.subarray(0,512).includes(0);
    const index=binary?'':body.subarray(0,4*1024*1024).toString('utf8');
    if(body.length<=256*1024)return{inline:body,hash:null,index};
    const hash=createHash('sha256').update(body).digest('hex'),dir=path.join(this.dir,'_blobs','sha256',hash.slice(0,2)),file=path.join(dir,hash+'.bin');
    mkdirSync(dir,{recursive:true});if(!existsSync(file))writeFileSync(file,body,{flag:'wx'});
    const preview=binary?`[binary ${type.trim()||'application/octet-stream'}, ${body.length} bytes, magic=${body.subarray(0,4).toString('hex')}]`:utf8Clip(body,8192);
    return{inline:Buffer.from(preview),hash,index};
  }
  private streamed(x:CapturedExchange){
    const body=x.respStream!;if(!body.file.startsWith(path.join(this.dir,'_capture-tmp')+path.sep)||!/^[a-f0-9]{64}$/.test(body.hash))throw new Error('invalid streamed capture');
    const dir=path.join(this.dir,'_blobs','sha256',body.hash.slice(0,2)),dest=path.join(dir,body.hash+'.bin');mkdirSync(dir,{recursive:true});if(existsSync(dest))unlinkSync(body.file);else renameSync(body.file,dest);
    const binary=binaryTypes.some(p=>x.contentType.trim().toLowerCase().startsWith(p))||x.respBody.subarray(0,512).includes(0);
    return {inline:Buffer.from(binary?'[binary '+x.contentType+', '+body.length+' bytes, magic='+x.respBody.subarray(0,4).toString('hex')+']':utf8Clip(x.respBody,8192)),hash:body.hash,index:binary?'':x.respBody.subarray(0,4*1024*1024).toString('utf8')};
  }
  record(x:CapturedExchange):string{
    const u=new URL(x.url),ts=x.ts??Math.floor(Date.now()/1000);let id:string;
    let attempts=0;do{if(++attempts>10000)throw new Error('capture ID space exhausted for this second');id=`${ts}-${String(++this.sequence%10000).padStart(4,'0')}`;}while(this.db.prepare('SELECT 1 FROM exchanges WHERE id=?').get(id));
    const req=this.spill(x.reqBody,x.requestType),resp=x.respStream?this.streamed(x):this.spill(x.respBody,x.contentType);
    this.db.exec('BEGIN IMMEDIATE');try{
      const r=this.db.prepare("INSERT INTO exchanges(id,ts,host,method,url_template,url,status,content_type,req_len,resp_len,path) VALUES(?,?,?,?,?,?,?,?,?,?,'')")
        .run(id,ts,u.hostname.replace(/^\[|\]$/g,''),x.method,template(u.pathname),x.url,x.status,x.contentType,x.reqBody.length,x.respStream?.length??x.respBody.length);
      this.db.prepare('INSERT INTO exchange_bodies VALUES(?,?,?,?,?,?,?)').run(id,x.reqHead,req.inline,req.hash,x.respHead,resp.inline,resp.hash);
      for(const hash of new Set([req.hash,resp.hash]))if(hash)this.db.prepare('INSERT OR IGNORE INTO blob_refs VALUES(?,?)').run(hash,id);
      if(this.fts)this.db.prepare('INSERT INTO ex_fts(rowid,content) VALUES(?,?)').run(r.lastInsertRowid,[x.url,x.reqHead,req.index,x.respHead,resp.index].join('\n'));
      if(x.context)this.db.prepare('UPDATE exchanges SET context=?,request_id=? WHERE id=?').run(JSON.stringify(x.context),x.context.requestId,id);
      this.db.exec('COMMIT');try{this.onCapture?.(id,x);}catch(e){console.warn('[traffic] observer',String(e));}return id;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  count():number{return Number(this.db.prepare('SELECT count(*) AS n FROM exchanges').get()!.n);}
  page(q:URLSearchParams,page:number,size:number):{exchanges:Meta[];total:number}{
    const where:string[]=[],args:SQLInputValue[]=[];const add=(s:string,...v:SQLInputValue[])=>{where.push(s);args.push(...v);};
    const value=(k:string)=>(q.get(k)??'').trim();
    if(value('host'))add('host LIKE ?','%'+value('host')+'%');if(value('method'))add('method=?',value('method').toUpperCase());
    if(value('path'))add('url_template LIKE ?','%'+value('path')+'%');
    const status=value('status').toLowerCase();if(/^[1-5]xx$/.test(status)){const n=Number(status[0])*100;add('status>=? AND status<?',n,n+100);}else if(/^[+-]?\d+$/.test(status))add('status=?',Number(status));
    for(const [key,op] of [['resp_min','>='],['resp_max','<=']]){const s=value(key!);if(s&&/^[+-]?\d+$/.test(s)&&Number(s)>=0)add(`resp_len${op}?`,Number(s));}
    const fts=(term:string)=>this.fts&&[...term].length>=3;const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';
    const term=value('q');if(term){const cols=['host','url','url_template','method','content_type','CAST(status AS TEXT)'];
      const clauses=cols.map(c=>`${c} LIKE ?`),values:SQLInputValue[]=cols.map(()=>'%'+term+'%');
      if(fts(term)){clauses.push('rowid IN (SELECT rowid FROM ex_fts WHERE ex_fts MATCH ?)');values.push(quote(term));}add('('+clauses.join(' OR ')+')',...values);}
    const body=value('body');if(body&&fts(body))add('rowid IN (SELECT rowid FROM ex_fts WHERE ex_fts MATCH ?)',quote(body));
    const clause=where.length?' WHERE '+where.map(s=>'('+s+')').join(' AND '):'';
    const total=Number(this.db.prepare('SELECT count(*) AS n FROM exchanges'+clause).get(...args)!.n);
    const sort=['ts','status','resp_len'].includes(value('sort').toLowerCase())?value('sort').toLowerCase():'ts',order=value('order').toLowerCase()==='asc'?'ASC':'DESC';
    page=Math.max(0,page);if(size<=0||size>500)size=100;
    const exchanges=this.db.prepare(`SELECT id,ts,host,method,url_template,url,status,content_type,resp_len,path FROM exchanges${clause} ORDER BY ${sort} ${order},id DESC LIMIT ? OFFSET ?`).all(...args,size,page*size) as unknown as Meta[];
    return{exchanges,total};
  }
  get(id:string):{req:string;resp:string}{
    const r=this.db.prepare('SELECT b.*,e.req_len,e.resp_len FROM exchange_bodies b JOIN exchanges e ON e.id=b.id WHERE b.id=?').get(id);
    if(!r){const e=this.db.prepare('SELECT path FROM exchanges WHERE id=?').get(id);if(e?.path){
      const root=path.resolve(this.dir,String(e.path));if(!root.startsWith(path.resolve(this.dir)+path.sep))throw new Error("Illegal exchange path");
      return{req:readFileSync(path.join(root,'request.http'),'utf8'),resp:readFileSync(path.join(root,'response.http'),'utf8')};}
      throw new Error(e?`exchange ${id} No text record`:`exchange ${id} does not exist`);}
    const raw=(side:string)=>`${r[side+'_head']}\n${Buffer.from((r[side+'_body']??[]) as Uint8Array).toString('utf8')}${r[side+'_blob']?`\n…[truncated] @blob sha256:${r[side+'_blob']} (len=${r[side==='req'?'req_len':'resp_len']})`:''}`;
    return{req:raw('req'),resp:raw('resp')};
  }
  readEvidence(id:string){
    const e=this.db.prepare('SELECT * FROM exchanges WHERE id=?').get(id);if(!e)throw new Error(`Traffic ${id}: sql: no rows in result set`);
    const b=this.db.prepare('SELECT *,CAST(req_head AS BLOB) AS req_head_bytes,CAST(resp_head AS BLOB) AS resp_head_bytes FROM exchange_bodies WHERE id=?').get(id);
    let reqHead:string,respHead:string,reqBody:Buffer,respBody:Buffer;
    const split=(side:string)=>{const file=path.resolve(this.dir,String(e.path),side+'.http');if(!file.startsWith(path.resolve(this.dir)+path.sep))throw new Error("Old traffic path is invalid");const raw=readFileSync(file);let start=0;while(start<raw.length){const next=raw.indexOf(10,start);if(next<0)return{head:raw.toString('utf8'),body:Buffer.alloc(0)};if(next===start||next===start+1&&raw[start]===13)return{head:raw.subarray(0,start).toString('utf8'),body:raw.subarray(next+1)};start=next+1;if(start>1048576)throw new Error("Old traffic packet header is too large");}return{head:raw.toString('utf8'),body:Buffer.alloc(0)};};
    if(b){reqHead=goUTF8(Buffer.from(b.req_head_bytes as Uint8Array));respHead=goUTF8(Buffer.from(b.resp_head_bytes as Uint8Array));reqBody=b.req_blob?readFileSync(this.blobFile(String(b.req_blob)).file):Buffer.from((b.req_body??[]) as Uint8Array);respBody=b.resp_blob?readFileSync(this.blobFile(String(b.resp_blob)).file):Buffer.from((b.resp_body??[]) as Uint8Array);}
    else if(e.path){const req=split('request'),resp=split('response');reqHead=req.head;respHead=resp.head;reqBody=req.body;respBody=resp.body;}else throw new Error(`Traffic ${id}: sql: no rows in result set`);
    return{context:e.context?JSON.parse(String(e.context)) as CaptureContext:undefined,id,ts:Number(e.ts),url:String(e.url),method:String(e.method),status:Number(e.status),content_type:String(e.content_type),req_len:Number(e.req_len),resp_len:Number(e.resp_len),reqHead,respHead,reqBody,respBody,req_hash:String(b?.req_blob??''),resp_hash:String(b?.resp_blob??'')};
  }
  blobFile(raw:string):{file:string;size:number;hash:string}{
    const hash=raw.trim().toLowerCase();if(!/^[0-9a-f]{64}$/.test(hash))throw new Error("Illegal blob hash");
    for(const suffix of [path.join(hash.slice(0,2),hash+'.bin'),path.join(hash.slice(0,2),hash.slice(2,4),hash+'.bin')]){
      const file=path.join(this.dir,'_blobs','sha256',suffix);if(existsSync(file)&&statSync(file).isFile())return{file,size:statSync(file).size,hash};}
    throw new Error(`blob ${hash} does not exist`);
  }
  hosts(){return this.db.prepare('SELECT host,COUNT(*) AS count FROM exchanges GROUP BY host ORDER BY MAX(ts) DESC').all();}
  search(host:string,contains:string,body:string,page:number,limit:number,taskId?:number):Meta[]{
    let name:string,port='';const raw=host.trim();if(!raw)throw new Error("host is a required parameter: please specify the bare host, host:port or complete URL to avoid full database scanning.");
    try{
      const authority=raw.includes('://')?raw.split('://')[1]!.split(/[/?#]/)[0]!:raw;
      const bracket=/^\[([^\]]+)\](?::(.*))?$/.exec(authority),single=/^([^:]+):(.*)$/.exec(authority);
      if(bracket){name=bracket[1]!;port=bracket[2]??'';}else if(single){name=single[1]!;port=single[2]!;}else name=authority;
      if(raw.includes('://'))name=new URL(raw).hostname.replace(/^\[|\]$/g,'');
      name=name.trim().toLowerCase();if(!name||port&&(!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535))throw new Error('invalid host');
    }catch{throw new Error(`Unable to resolve host:${JSON.stringify(raw)}`);}
    const where=['host=?'],args:SQLInputValue[]=[name];if(port){const authority=(name.includes(':')?'['+name+']':name)+':'+Number(port);where.push('(url LIKE ? OR url LIKE ? OR url LIKE ?)');args.push('%://'+authority+'/%','%://'+authority+'?%','%://'+authority);}
    if(taskId){where.push("json_extract(context,'$.taskId')=?");args.push(taskId);}
    if(contains){where.push('(url LIKE ? OR url_template LIKE ?)');args.push('%'+contains+'%','%'+contains+'%');}
    body=body.trim();if(body){if(!this.fts)throw new Error("Full-text indexing is not enabled for the current instance and search by text cannot be enabled");if([...body].length<3)throw new Error(`Text search keywords require at least 3 characters (currently ${[...body].length} )`);
      where.push('rowid IN (SELECT rowid FROM ex_fts WHERE ex_fts MATCH ?)');args.push('"'+body.replaceAll('"','""')+'"');}
    limit=limit<=0?3:Math.min(10,limit);page=Math.max(0,page);
    return this.db.prepare(`SELECT id,ts,host,method,url_template,url,status,content_type,resp_len,path FROM exchanges WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ? OFFSET ?`).all(...args,limit,page*limit) as unknown as Meta[];
  }
  /** Task cleanup uses capture ownership, never host/domain-wide deletion. */
  taskResources(taskId:number){
    const rows=this.db.prepare("SELECT e.id,e.rowid,e.ts,e.context,e.req_len,e.resp_len,b.req_blob,b.resp_blob,length(CAST(b.req_head AS BLOB))+COALESCE(length(b.req_body),0)+length(CAST(b.resp_head AS BLOB))+COALESCE(length(b.resp_body),0) inline_bytes FROM exchanges e LEFT JOIN exchange_bodies b ON b.id=e.id WHERE json_extract(e.context,'$.taskId')=? ORDER BY e.id").all(taskId);
    const hashes=[...new Set(rows.flatMap(r=>[r.req_blob,r.resp_blob]).filter(Boolean).map(String))];
    const blobs=hashes.map(hash=>{
      const owners=this.db.prepare("SELECT DISTINCT CAST(json_extract(e.context,'$.taskId') AS TEXT) owner FROM blob_refs b JOIN exchanges e ON e.id=b.exchange_id WHERE b.hash=?").all(hash).map(r=>r.owner==null?'unassigned':String(r.owner));
      try{const info=this.blobFile(hash),s=statSync(info.file);const exchanges=this.db.prepare('SELECT exchange_id FROM blob_refs WHERE hash=?').all(hash).map(r=>String(r.exchange_id));return {hash,file:info.file,bytes:s.blocks*512,owners,exchanges};}
      catch{return {hash,file:'',bytes:0,owners,missing:true};}
    });
    return {rows,blobs};
  }
  removeTaskExchanges(taskIds:number[],ids:string[]){
    let deleted=0,bytes=0;
    const owners=new Set(taskIds);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      for(const id of ids){
        const row=this.db.prepare("SELECT rowid,context FROM exchanges WHERE id=?").get(id);if(!row)continue;
        const owner=JSON.parse(String(row.context||'{}')).taskId;
        if(!owners.has(Number(owner)))throw new Error("Traffic attribution has changed, please preview again");
        const size=this.db.prepare('SELECT length(CAST(req_head AS BLOB))+COALESCE(length(req_body),0)+length(CAST(resp_head AS BLOB))+COALESCE(length(resp_body),0) n FROM exchange_bodies WHERE id=?').get(id);
        bytes+=Number(size?.n??0);
        if(this.fts)this.db.prepare('DELETE FROM ex_fts WHERE rowid=?').run(row.rowid!);
        this.db.prepare('DELETE FROM blob_refs WHERE exchange_id=?').run(id);
        this.db.prepare('DELETE FROM exchange_bodies WHERE id=?').run(id);
        this.db.prepare('DELETE FROM exchanges WHERE id=?').run(id);deleted++;
      }
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    return {deleted,database_reusable_bytes:bytes};
  }
  blobReferenced(hash:string){return !!this.db.prepare('SELECT 1 FROM blob_refs WHERE hash=? LIMIT 1').get(hash);}
  storageOverview(){
    const index=path.join(this.dir,'_index','index.sqlite');
    const index_bytes=[index,index+'-wal',index+'-shm'].reduce((n,f)=>n+(existsSync(f)?statSync(f).blocks*512:0),0);
    return {index_bytes,unassigned_exchanges:Number(this.db.prepare("SELECT count(*) n FROM exchanges WHERE json_extract(context,'$.taskId') IS NULL").get()!.n)};
  }
  compactReleasedPages(){
    const page=Number(this.db.prepare('PRAGMA page_size').get()!.page_size);
    const free=Number(this.db.prepare('PRAGMA freelist_count').get()!.freelist_count);
    // Bounded maintenance, never a full VACUUM on the shared live capture DB.
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE);PRAGMA incremental_vacuum(512)');
    return {reusable_bytes:free*page};
  }
  deleteHosts(hosts:string[],exact:boolean):number{
    if(!hosts.length)return 0;const condition=exact?`host IN (${hosts.map(()=>'?').join(',')})`:'host LIKE ?';
    const args=exact?hosts:['%'+hosts[0]+'%'];const rows=this.db.prepare(`SELECT id,rowid FROM exchanges WHERE ${condition}`).all(...args);
    const hashes=new Set<string>();this.db.exec('BEGIN IMMEDIATE');try{
      for(const row of rows){for(const b of this.db.prepare('SELECT hash FROM blob_refs WHERE exchange_id=?').all(row.id!))hashes.add(String(b.hash));
        if(this.fts)this.db.prepare('DELETE FROM ex_fts WHERE rowid=?').run(row.rowid!);
        this.db.prepare('DELETE FROM blob_refs WHERE exchange_id=?').run(row.id!);this.db.prepare('DELETE FROM exchange_bodies WHERE id=?').run(row.id!);this.db.prepare('DELETE FROM exchanges WHERE id=?').run(row.id!);}
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    for(const hash of hashes)if(!this.db.prepare('SELECT 1 FROM blob_refs WHERE hash=?').get(hash)){try{unlinkSync(this.blobFile(hash).file);}catch(e){if(existsSync(path.join(this.dir,'_blobs','sha256',hash.slice(0,2),hash+'.bin')))console.warn('[traffic] blob reclaim failed:',String(e));}}
    return rows.length;
  }
  deleteAll():{deleted:number;reclaimed:number}{
    const index=path.join(this.dir,'_index','index.sqlite'),bytes=()=>[index,index+'-wal',index+'-shm'].reduce((n,f)=>n+(existsSync(f)?statSync(f).size:0),0),before=bytes();
    const deleted=this.deleteHosts(this.hosts().map(r=>String(r.host)),true);
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);VACUUM;PRAGMA wal_checkpoint(TRUNCATE)');
    return{deleted,reclaimed:Math.max(0,before-bytes())};
  }
}
