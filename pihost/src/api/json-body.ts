import type {IncomingMessage} from 'node:http';
/** Keep invalid JSON distinct from a legitimate empty/null configuration. */
export async function readObject(req:IncomingMessage,limit=1024*1024,allowNull=false):Promise<Record<string,any>>{
 const chunks:Buffer[]=[];let size=0;for await(const chunk of req){const b=Buffer.from(chunk);size+=b.length;if(size<=limit)chunks.push(b);}if(size>limit)throw new Error('request body too large');
 const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(value===null&&allowNull)return {};if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid body');return value;
}
