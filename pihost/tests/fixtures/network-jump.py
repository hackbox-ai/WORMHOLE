#!/usr/bin/env python3
import sys,os,socket,threading,select,http.server,ssl,subprocess,time,json,signal
signal.signal(signal.SIGTERM,lambda *_:sys.exit(0))
control_socket,control_port,http_port,https_port,folder,marker,frpc=sys.argv[1:]
subprocess.run(['mount','--make-rprivate','/'],check=True)
subprocess.run(['ip','link','set','lo','up'],check=True)
subprocess.run(['mount','--bind',folder+'/hosts','/etc/hosts'],check=True)
def forward(client):
 peer=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
 try:
  peer.connect(control_socket)
  channels={client:peer,peer:client}
  while True:
   ready,_,_=select.select(list(channels),[],[],30)
   if not ready:return
   for source in ready:
    data=source.recv(65536)
    if not data:return
    channels[source].sendall(data)
 except OSError:pass
 finally:client.close();peer.close()
listener=socket.socket();listener.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
listener.bind(('127.0.0.1',int(control_port)));listener.listen(32)
def accept():
 while True:
  client,_=listener.accept();threading.Thread(target=forward,args=(client,),daemon=True).start()
threading.Thread(target=accept,daemon=True).start()
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  if self.path=='/slow':
   with open(folder+'/slow.started','w') as record:record.write(marker)
   time.sleep(45)
  if self.path=='/login':
   body=('<html><body><h1>'+marker+'</h1><form method="post" action="/login"><input name="user"/><button>Login</button></form></body></html>').encode();content='text/html'
  else:body=json.dumps({'marker':marker,'path':self.path,'cookie':self.headers.get('Cookie','')}).encode();content='application/json'
  self.send_response(200);self.send_header('Content-Type',content);self.send_header('Content-Length',str(len(body)));self.end_headers()
  try:self.wfile.write(body)
  except OSError:pass
 def do_POST(self):
  body=self.rfile.read(int(self.headers.get('Content-Length','0')))
  response=json.dumps({'marker':marker,'body':body.decode()}).encode()
  self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Set-Cookie','fixture='+marker+'; Path=/');self.send_header('Content-Length',str(len(response)));self.end_headers();self.wfile.write(response)
http_target=http.server.ThreadingHTTPServer(('127.0.0.1',int(http_port)),Handler)
threading.Thread(target=http_target.serve_forever,daemon=True).start()
https=http.server.ThreadingHTTPServer(('127.0.0.1',int(https_port)),Handler)
tls=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);tls.load_cert_chain(folder+'/target.crt',folder+'/target.key');https.socket=tls.wrap_socket(https.socket,server_side=True)
threading.Thread(target=https.serve_forever,daemon=True).start()
process=subprocess.Popen([frpc,'-c',folder+'/frpc.toml'],cwd=folder)
try:raise SystemExit(process.wait())
finally:process.terminate();http_target.shutdown();https.shutdown()
