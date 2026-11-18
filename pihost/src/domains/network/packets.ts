import {createServer,connect,isIP,type Socket} from 'node:net';
import {chmod,rm} from 'node:fs/promises';
import type {Channel} from './channels.ts';
import {channelAllows} from './channels.ts';
/** Only this task-bound UDS is exposed to the raw-network namespace. */
export async function packetGateway(socketPath:string,row:Channel,token:string,active:()=>Promise<void>){
 const peers=new Set<Socket>(),cache=new Map<string,number>();let closing=false;
 const server=createServer(client=>{
  peers.add(client);client.on('close',()=>peers.delete(client));client.on('error',()=>client.destroy());client.setTimeout(15000,()=>client.destroy());
  let header=Buffer.alloc(0);
  const initial=(chunk:Buffer)=>{header=Buffer.concat([header,chunk]);const n=header.indexOf(10);if(n<0){if(header.length>8192)client.destroy();return;}client.removeListener('data',initial);
   let input:{op:string;host?:string};try{input=JSON.parse(header.subarray(0,n).toString());}catch{client.destroy();return;}
   void (async()=>{
    await active();if(closing)throw new Error('closed');
    if(!['packets','resolve'].includes(input.op))throw new Error('operation');
    if(input.op==='resolve'&&(!input.host||!channelAllows(row.scopes,new URL('http://'+input.host))))throw new Error('domain outside channel scope');
    const remote=connect(row.packet_port!,'127.0.0.1');peers.add(remote);remote.on('close',()=>{peers.delete(remote);client.destroy();});remote.on('error',()=>remote.destroy());client.on('close',()=>remote.destroy());
    remote.setTimeout(15000,()=>remote.destroy());remote.on('connect',()=>remote.write(JSON.stringify({...input,token})+'\n'));
    let response=Buffer.alloc(0);
    const ready=(data:Buffer)=>{response=Buffer.concat([response,data]);const newline=response.indexOf(10);if(newline<0){if(response.length>8192)remote.destroy();return;}remote.removeListener('data',ready);
     let result:any;try{result=JSON.parse(response.subarray(0,newline).toString());}catch{remote.destroy();return;}
     if(input.op==='resolve'){if(result.ok&&Array.isArray(result.addresses))for(const ip of result.addresses)if(isIP(ip)){for(const [key,expiry]of cache)if(expiry<Date.now())cache.delete(key);if(cache.size>=4096)cache.delete(cache.keys().next().value!);cache.set(ip,Date.now()+55000);}client.end(response,()=>remote.destroy());return;}
     client.write(response.subarray(0,newline+1));if(!result.ok){remote.destroy();return;}
     const source4=String(result.client).split('/')[0],source6=String(result.client6).split('/')[0];
     const pins=new Set<string>();const allowed=(ip:string)=>{if(channelAllows(row.scopes,new URL('http://'+(ip.includes(':')?'['+ip+']':ip))))return true;if(pins.has(ip))return true;const ok=pins.size<4096&&(cache.get(ip)??0)>Date.now();if(ok)pins.add(ip);return ok;};
     let frames=header.subarray(n+1);
     const consume=(chunk:Buffer)=>{frames=Buffer.concat([frames,chunk]);while(frames.length>=4){const size=frames.readUInt32BE(0);if(size<20||size>65535){client.destroy();return;}if(frames.length<size+4)break;
       const packet=frames.subarray(4,size+4);let src='',dst='';
       if(packet[0]!>>4===4&&packet.length>=20){src=Array.from(packet.subarray(12,16)).join('.');dst=Array.from(packet.subarray(16,20)).join('.');}
       else if(packet[0]!>>4===6&&packet.length>=40){const asIP=(offset:number)=>new URL('http://['+Array.from({length:8},(_,i)=>packet.readUInt16BE(offset+i*2).toString(16)).join(':')+']').hostname.slice(1,-1);src=asIP(8);dst=asIP(24);}
       if((src!==source4&&src!==source6)||!allowed(dst)){frames=frames.subarray(size+4);continue;}
       if(!remote.write(frames.subarray(0,size+4))){client.pause();remote.once('drain',()=>client.resume());}
       frames=frames.subarray(size+4);
      }};
     client.setTimeout(0);remote.setTimeout(0);client.on('data',consume);if(frames.length){const existing=frames;frames=Buffer.alloc(0);consume(existing);}
     const rest=response.subarray(newline+1);if(rest.length)client.write(rest);
     remote.pipe(client);
    };remote.on('data',ready);
   })().catch(()=>client.destroy());
  };client.on('data',initial);
 });
 await new Promise<void>((resolve,reject)=>server.once('error',reject).listen(socketPath,resolve));await chmod(socketPath,0o600);
 let checking=false;const interval=setInterval(()=>{if(checking||closing)return;checking=true;void active().catch(()=>{for(const p of peers)p.destroy();}).finally(()=>{checking=false;});},1000);interval.unref();
 return {close:async()=>{closing=true;clearInterval(interval);for(const p of peers)p.destroy();await new Promise<void>(r=>server.close(()=>r()));await rm(socketPath,{force:true});}};
}
