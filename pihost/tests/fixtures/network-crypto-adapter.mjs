import {createCipheriv,createDecipheriv,createHmac} from 'node:crypto';
const key=Buffer.from('11'.repeat(32),'hex'),iv=Buffer.from('22'.repeat(16),'hex');
export function encodeRequest(r){const c=createCipheriv('aes-256-cbc',key,iv);const body=JSON.stringify({data:Buffer.concat([c.update(r.body),c.final()]).toString('base64')});return {body,headers:{'content-type':'application/json','x-signature':createHmac('sha256','fixture-hmac').update(body).digest('hex')}};}
export function decodeResponse(r){const d=createDecipheriv('aes-256-cbc',key,iv);return {body:Buffer.concat([d.update(Buffer.from(JSON.parse(r.body).data,'base64')),d.final()]),decoded:true};}
