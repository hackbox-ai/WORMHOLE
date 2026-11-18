import {createServer} from 'node:http';
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/plain; charset=utf-8');if(req.method!=='GET'){res.statusCode=405;res.end('Read only');return;}res.statusCode=req.url==='/'?200:404;res.end(req.url==='/'?'Controlled plain service. No product banner.':'Resource absent.');});
server.listen(31692,'127.0.0.1',()=>console.log('Controlled negative service listening on 127.0.0.1:31692'));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
