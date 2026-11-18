import {gunzipSync,inflateSync,inflateRawSync,brotliDecompressSync} from 'node:zlib';
export function decodeTargetBytes(wire:Buffer,encoding:string):Buffer{
 let bytes=wire;for(const method of encoding.split(',').map(v=>v.trim().toLowerCase()).filter(Boolean).reverse()){
  const options={maxOutputLength:32*1024*1024};
  if(method==='gzip')bytes=gunzipSync(bytes,options);else if(method==='br')bytes=brotliDecompressSync(bytes,options);
  else if(method==='deflate'){try{bytes=inflateSync(bytes,options)}catch(e){if((e as NodeJS.ErrnoException).code!=='Z_DATA_ERROR')throw e;bytes=inflateRawSync(bytes,options)}}
  else if(method!=='identity')throw new Error("Unsupported response compression format: "+method);
 }
 return bytes;
}
export function decodeTargetBody(wire:Buffer,encoding:string,contentType:string):string{const charset=/charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1]??'utf-8';return new TextDecoder(charset).decode(decodeTargetBytes(wire,encoding));}
