import sys,os,socket,threading,select,http.server,subprocess,json,signal,base64,hashlib,hmac,time
folder,marker=sys.argv[1:]
subprocess.run(['ip','link','set','lo','up'],check=True)
for i in range(100):
 if subprocess.run(['ip','link','show','gtyt0'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
 time.sleep(.05)
for args in [['addr','add','10.88.0.2/30','dev','gtyt0'],['-6','addr','add','fd90::2/64','dev','gtyt0','nodad'],['addr','add','10.88.0.6/32','dev','gtyt0'],['link','set','gtyt0','up']]:subprocess.run(['ip',*args],check=True)
def serve(listener,fn):
 listener.listen(32)
 def accept():
  while True:
   client,_=listener.accept();threading.Thread(target=fn,args=(client,),daemon=True).start()
 threading.Thread(target=accept,daemon=True).start()
tcp=socket.socket();tcp.bind(('0.0.0.0',19002))
def echo(c):
    try:
        while True:
            data=c.recv(4096)
            if not data:return
            c.sendall(marker.encode()+b':'+data)
    except OSError:pass
    finally:c.close()
serve(tcp,echo)
def udp_echo(family,address):
    udp=socket.socket(family,socket.SOCK_DGRAM);udp.bind(address)
    while True:
        data,peer=udp.recvfrom(4096);udp.sendto(marker.encode()+b':'+data,peer)
threading.Thread(target=udp_echo,args=(socket.AF_INET,('10.88.0.2',19001)),daemon=True).start()
threading.Thread(target=udp_echo,args=(socket.AF_INET6,('fd90::2',19001)),daemon=True).start()
KEY='11'*32;IV='22'*16
def aes(data,decrypt=False):
    args=['openssl','enc','-aes-256-cbc','-K',KEY,'-iv',IV]
    if decrypt:args.append('-d')
    return subprocess.run(args,input=data,check=True,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL).stdout
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def send_json(self,value):
        body=json.dumps(value).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    def do_GET(self):
        self.send_json({'marker':marker,'tuns':subprocess.run(['ip','-j','link','show'],stdout=subprocess.PIPE).stdout.decode()})
    def do_POST(self):
        raw=self.rfile.read(int(self.headers.get('Content-Length','0')))
        print('fixture HTTP',self.path,len(raw),flush=True)
        if self.path=='/secure':
            if self.headers.get('X-Signature')!=hmac.new(b'fixture-hmac',raw,hashlib.sha256).hexdigest():self.send_error(400);return
            value=json.loads(aes(base64.b64decode(json.loads(raw)['data']),True))
            self.send_json({'data':base64.b64encode(aes(json.dumps({'marker':marker,'echo':value}).encode())).decode()})
        elif self.path=='/mcp':
            req=json.loads(raw);method=req.get('method')
            if method.startswith('notifications/'):self.send_response(202);self.send_header('Content-Length','0');self.end_headers();return
            if method=='initialize':result={'protocolVersion':req['params']['protocolVersion'],'capabilities':{'tools':{}},'serverInfo':{'name':'jump-http','version':'1'}}
            elif method=='tools/list':result={'tools':[{'name':'site','description':'site marker','inputSchema':{'type':'object'}}]}
            elif method=='tools/call':result={'content':[{'type':'text','text':marker}]}
            else:result={}
            self.send_json({'jsonrpc':'2.0','id':req['id'],'result':result})
        else:self.send_json({'marker':marker,'body':raw.decode()})
http=http.server.ThreadingHTTPServer(('10.88.0.2',19000),Handler)
threading.Thread(target=http.serve_forever,daemon=True).start()

while True:time.sleep(30)
