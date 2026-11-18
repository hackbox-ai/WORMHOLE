import {TaskResources} from './resources.ts';
import {WorkspaceMaintenance,safeWorkspacePath,workspaceGate} from './maintenance.ts';
/** Workspace DTOs and Linux path semantics. */
import {mkdir,readdir,readFile,stat,lstat,writeFile,copyFile} from 'node:fs/promises';
import {isUtf8} from 'node:buffer';
import path from 'node:path';
import type {Pool} from 'pg';
import {appendEvent} from '../../events/ledger.ts';
import type {MultipartFile} from './multipart.ts';
export const MAX_READ=2<<20,MAX_UPLOAD=512<<20;
export {WorkspaceError} from './errors.ts';
import {WorkspaceError} from './errors.ts';
export class WorkspaceService {
  readonly root:string;
  readonly maintenance:WorkspaceMaintenance;
  readonly resources:TaskResources;
  constructor(private pool:Pool,private dlqPath:string,root:string){this.root=path.resolve(root);this.maintenance=new WorkspaceMaintenance(pool,this.root,dlqPath);this.resources=new TaskResources(pool,path.dirname(this.root),this.maintenance);}
  resolve(rel=''):string {
    // filepath.Clean("/"+rel) neutralizes traversal rather than rejecting it.
    const clean=path.posix.normalize('/'+rel.trim().replace(/^\//,''));
    const target=path.join(this.root,clean.slice(1));
    if(target!==this.root&&!target.startsWith(this.root+path.sep))throw new WorkspaceError(400,"Illegal path");
    return target;
  }
  relative(abs:string):string{return path.relative(this.root,abs).split(path.sep).join('/');}
  async ensure():Promise<void>{await mkdir(this.root,{recursive:true,mode:0o755});}
  async list(rel='') {
    await this.ensure();const dir=this.resolve(rel);await safeWorkspacePath(this.root,this.relative(dir),true);const info=await stat(dir).catch(()=>null);
    if(!info)throw new WorkspaceError(404,"Path does not exist");if(!info.isDirectory())throw new WorkspaceError(400,"is not a directory");
    const out=[];
    for(const e of await readdir(dir,{withFileTypes:true})){
      const full=path.join(dir,e.name),s=await lstat(full).catch(()=>null);if(!s)continue;
      out.push({name:e.name,path:this.relative(full),dir:e.isDirectory(),size:s.size,mtime:Math.floor(s.mtimeMs)});
    }
    const compare=(a:string,b:string)=>Buffer.compare(Buffer.from(a.toLowerCase()),Buffer.from(b.toLowerCase()));
    out.sort((a,b)=>Number(b.dir)-Number(a.dir)||compare(a.name,b.name));
    return {path:this.relative(dir),entries:out};
  }
  async read(rel:string) {return this.mutate(rel,()=>this.readRaw(rel));}
  private async readRaw(rel:string) {
    const full=this.resolve(rel);await safeWorkspacePath(this.root,this.relative(full),true);const s=await stat(full).catch(()=>null);
    if(!s)throw new WorkspaceError(404,"File does not exist");if(s.isDirectory())throw new WorkspaceError(400,"is a directory and cannot be read as a file");
    const base={path:this.relative(full),size:s.size};
    if(s.size>MAX_READ)return {...base,too_large:true,binary:true};
    const buf=await readFile(full);if(buf.includes(0)||!isUtf8(buf))return {...base,binary:true};
    return {...base,binary:false,content:buf.toString('utf8')};
  }
  async write(rel:string,content:string) {return this.mutate(rel,()=>this.writeRaw(rel,content));}
  private async writeRaw(rel:string,content:string) {
    const full=this.resolve(rel);if(full===this.root)throw new WorkspaceError(400,"Illegal path");
    if((await stat(full).catch(()=>null))?.isDirectory())throw new WorkspaceError(400,"The target is a directory");
    await mkdir(path.dirname(full),{recursive:true,mode:0o755});await writeFile(full,content,{mode:0o644});
    await this.audit('write',{path:this.relative(full),bytes:Buffer.byteLength(content)});return {ok:true,path:this.relative(full)};
  }
  async makeDir(rel:string) {return this.mutate(rel,()=>this.makeDirRaw(rel));}
  private async makeDirRaw(rel:string) {
    const full=this.resolve(rel);if(full===this.root)throw new WorkspaceError(400,"Illegal path");
    await mkdir(full,{recursive:true,mode:0o755});return {ok:true,path:this.relative(full)};
  }
  async remove(rel:string) {
    const full=this.resolve(rel);if(full===this.root)throw new WorkspaceError(400,"Cannot delete workspace root directory");
    if(!await lstat(full).catch(()=>null))throw new WorkspaceError(404,"Path does not exist");
    const plan=await this.maintenance.preview([this.relative(full)]);
    if(plan.protected_files&&!plan.removable_files)throw new WorkspaceError(409,"The selected file is protected and cannot be deleted");
    const result=await this.maintenance.execute(plan.token);if(result.failed.length)throw new WorkspaceError(500,"Deletion of some files failed:"+result.failed[0]!.error);return {ok:true};
  }
  async download(rel:string) {
    const full=this.resolve(rel);await safeWorkspacePath(this.root,this.relative(full),true);const s=await stat(full).catch(()=>null);
    if(!s||s.isDirectory())throw new WorkspaceError(404,"File does not exist");
    return {full,name:path.basename(full),size:s.size,mtime:s.mtime};
  }
  async uploadDirectory(rel:string):Promise<string>{
    await this.ensure();const full=this.resolve(rel);await safeWorkspacePath(this.root,this.relative(full),true);
    if(!(await stat(full).catch(()=>null))?.isDirectory())throw new WorkspaceError(400,"Target directory does not exist");return full;
  }
  async upload(rel:string,files:MultipartFile[]) {return this.mutate(rel,()=>this.uploadRaw(rel,files));}
  private async uploadRaw(rel:string,files:MultipartFile[]) {
    const dir=await this.uploadDirectory(rel);if(!files.length)throw new WorkspaceError(400,"Missing upload file (form field file)");
    let saved=0;
    for(const file of files){const name=path.posix.basename(file.name);if(!name||name==='.'||name==='..')continue;
      const full=this.resolve(path.posix.join(this.relative(dir),name));await safeWorkspacePath(this.root,this.relative(full),true);await copyFile(file.tempPath,full);saved++;
    }
    await this.audit('upload',{path:this.relative(dir),uploaded:saved});return {uploaded:saved};
  }
  private async mutate<T>(rel:string,action:()=>Promise<T>):Promise<T>{
    const full=this.resolve(rel),release=workspaceGate.use(full);
    try{await safeWorkspacePath(this.root,this.relative(full),true);return await action();}finally{release();}
  }
  private async audit(event:string,payload:Record<string,unknown>):Promise<void>{await appendEvent(this.pool,this.dlqPath,{business_kind:'workspace',business_id:'global',event_type:event,payload});}
}
