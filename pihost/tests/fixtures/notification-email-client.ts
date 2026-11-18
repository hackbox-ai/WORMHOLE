import {sendEmail} from '../../src/domains/notify/email.ts';
import {PermanentNotificationError} from '../../src/domains/notify/dispatcher.ts';
let input='';process.stdin.setEncoding('utf8');for await(const chunk of process.stdin)input+=chunk;
const {config,message}=JSON.parse(input);let result;
try{result={delivered:await sendEmail(config,message,AbortSignal.timeout(5000)),permanent:false,error:''};}catch(e){result={delivered:0,permanent:e instanceof PermanentNotificationError,error:(e as Error).message};}
process.stdout.write(JSON.stringify(result));
