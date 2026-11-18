import SMTPConnection from 'nodemailer/lib/smtp-connection';
import {createConnection,isIP,type Socket} from 'node:net';
import {connect as tlsConnect} from 'node:tls';
import {cfgString,cfgStrings,cfgInt,cfgBool,checkDialAddress,validateConfig} from './config.ts';
import {guardedLookup} from './http.ts';
import {PermanentNotificationError} from './dispatcher.ts';
import {htmlBody,messageTitle,type NotificationMessage} from './render.ts';

/** mime.QEncoding.Encode("utf-8", title), including rune-safe word splitting. */
export function encodeSubject(text:string):string{
  if(!Array.from(text).some(c=>{const n=c.codePointAt(0)!;return (n<32||n>126)&&n!==9;}))return text;
  const words:string[]=[];let current='';
  for(const c of text){let value='';for(const b of Buffer.from(c))value+=b===32?'_':b>=33&&b<=126&&![61,63,95].includes(b)?String.fromCharCode(b):'='+b.toString(16).toUpperCase().padStart(2,'0');if(current.length+value.length>63){words.push(current);current='';}current+=value;}
  words.push(current);return words.map(w=>'=?utf-8?q?'+w+'?=').join(' ');
}
export function buildEmailMessage(from:string,to:string[],message:NotificationMessage):string{
  const encoded=Buffer.from(htmlBody(message)).toString('base64'),lines=encoded.match(/.{1,76}/g)??[''];
  return `From: ${from}\r\nTo: ${to.join(', ')}\r\nSubject: ${encodeSubject(messageTitle(message))}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${lines.join('\r\n')}\r\n`;
}

/** WORMHOLE aborts the whole envelope on the first rejected recipient, whereas
 * Nodemailer normally accepts partial delivery. These two isolated hooks are
 * pinned to 10.1.0 and tested at the SMTP protocol boundary. No own SMTP parser. */
class StrictSMTPConnection extends SMTPConnection {
  _setEnvelope(envelope:unknown,callback:(error?:Error)=>void):void{
    const self=this as any;self._supportedExtensions=self._supportedExtensions.filter((x:string)=>x!=='PIPELINING');
    (SMTPConnection.prototype as any)._setEnvelope.call(this,envelope,callback);
  }
  _actionRCPT(response:string,callback:(error?:Error)=>void):void{
    if(!response.startsWith('2')){const e=Object.assign(new Error(response),{response,responseCode:Number(response.slice(0,3)),command:'RCPT TO',recipient:(this as any)._recipientQueue[0]});callback(e);return;}
    (SMTPConnection.prototype as any)._actionRCPT.call(this,response,callback);
  }
}
function smtpStageError(error:Error&{responseCode?:number;response?:string;command?:string;recipient?:string},from:string):Error{
  const raw=error.response??error.message,code=error.responseCode??Number(/^\d{3}/.exec(raw)?.[0]??0);
  const message=error.command==='MAIL FROM'?`Sender ${from} Rejected: ${raw}`:error.command==='RCPT TO'?`Recipient ${error.recipient??''} Rejected: ${raw}`:error.command==='DATA'&&!error.message.startsWith('Message failed')?`SMTP DATA failed: ${raw}`:`Failed to submit email: ${raw}`;
  return ['MAIL FROM','RCPT TO'].includes(error.command??'')&&code>=500&&code<600?new PermanentNotificationError(message):new Error(message);
}
async function dial(host:string,port:number,secure:boolean,signal:AbortSignal):Promise<Socket>{
  if(isIP(host))checkDialAddress(host);
  return await new Promise<Socket>((resolve,reject)=>{
    const options={host,port,lookup:guardedLookup,signal,timeout:10000};let socket:Socket;
    const connected=()=>{socket.off('error',reject);socket.setTimeout(0);resolve(socket);};
    socket=secure?tlsConnect({...options,...(isIP(host)?{}:{servername:host}),minVersion:'TLSv1.2'},connected):createConnection(options,connected);
    socket.once('error',reject);socket.once('timeout',()=>socket.destroy(new Error("Connection timeout")));
  });
}
export async function sendEmail(config:Record<string,unknown>,message:NotificationMessage,signal:AbortSignal):Promise<number>{
  try{validateConfig('email',config);}catch(e){throw new PermanentNotificationError((e as Error).message);}
  const host=cfgString(config,'host'),port=cfgInt(config,'port'),from=cfgString(config,'from'),to=cfgStrings(config,'to'),username=cfgString(config,'username'),secure=!!cfgBool(config,'tls'),raw=buildEmailMessage(from,to,message);
  // Source net/smtp validates envelope CRLF before sending any message data.
  for(const address of [from,...to])if(/[\r\n]/.test(address))throw new Error((address===from?`Sender ${address}`:`Recipient ${address}`)+" Rejected: smtp: A line must not contain CR or LF");
  let socket:Socket;try{socket=await dial(host,port,secure,signal);}catch(e){throw new Error("Failed to connect to SMTP server: "+(e as Error).message);}
  const conn=new StrictSMTPConnection({connection:socket,secured:secure,secure,host,port,name:'localhost',...(isIP(host)?{}:{servername:host}),tls:{...(isIP(host)?{}:{servername:host}),minVersion:'TLSv1.2'},connectionTimeout:10000,greetingTimeout:45000,socketTimeout:45000,logger:false,debug:false,
    // Public SASL hook preserves Go PlainAuth's valid empty-password case.
    customAuth:{PLAIN:async ctx=>{const response=await ctx.sendCommand('AUTH PLAIN '+Buffer.from('\0'+username+'\0'+cfgString(config,'password')).toString('base64'));if(response.status===235){ctx.resolve();return;}await ctx.sendCommand('*');const reason=response.status===334?'unexpected server challenge':response.response;ctx.reject(Object.assign(new Error(reason),{notificationResponse:reason}));}},
  });
  const cancel=()=>conn.close();signal.addEventListener('abort',cancel,{once:true});const timer=setTimeout(cancel,45000);timer.unref();
  const protocol=(fn:(done:(error?:Error|null)=>void)=>void)=>new Promise<void>((resolve,reject)=>{const failure=(e:Error)=>{cleanup();reject(e);},ended=()=>failure(new Error("SMTP connection closed")),cleanup=()=>{conn.off('error',failure);conn.off('end',ended);};conn.once('error',failure);conn.once('end',ended);fn(error=>{cleanup();error?reject(error):resolve();});});
  // Always consume errors during shutdown between protocol callbacks.
  conn.on('error',()=>{});
  try{
    try{await protocol(done=>conn.connect(()=>done()));}catch(e){throw new Error("SMTP handshake failed: "+(e as Error).message);}
    if(username){if(!conn.secure&&!['localhost','127.0.0.1','::1'].includes(host))throw new PermanentNotificationError("Credentials refused: The connection is not encrypted. Please enable TLS, or use port 465 (implicit TLS), or check \"Enable TLS\" (unencrypted connection)");try{await protocol(done=>conn.login({user:username,pass:cfgString(config,'password'),method:'PLAIN'},done));}catch(e){throw new PermanentNotificationError("SMTP authentication failed: "+((e as any).notificationResponse??(e as any).response??(e as Error).message));}}
    try{await protocol(done=>conn.send({from,to,use8BitMime:true},raw,error=>done(error)));}catch(e){throw smtpStageError(e as any,from);}
    if(!conn.destroyed)await new Promise<void>(resolve=>{conn.once('end',resolve);conn.quit();});return message.items.length;
  }finally{clearTimeout(timer);signal.removeEventListener('abort',cancel);conn.close();}
}
