#!/usr/bin/env python3
"""Private site namespace; a downstream site gets only its parent's relay UDS."""
import sys,os,socket,threading,select,http.server,subprocess,json,signal,base64,hashlib,hmac,time
signal.signal(signal.SIGTERM,lambda *_:sys.exit(0))
folder,control_socket,entry_port,relay_port,marker,runtime=sys.argv[1:]
subprocess.run(['mount','--make-rprivate','/'],check=True)
# Fresh procfs belongs to this private PID/mount namespace, including writable network sysctls.
subprocess.run(['mount','-t','proc','proc','/proc'],check=True)
subprocess.run(['ip','link','set','lo','up'],check=True)
open('/proc/sys/net/ipv4/ip_forward','w').write('0')
open('/proc/sys/net/ipv6/conf/all/forwarding','w').write('0')
subprocess.run(['mount','--bind',folder+'/hosts','/etc/hosts'],check=True)
def forward(client,address,unix=False):
    peer=socket.socket(socket.AF_UNIX if unix else socket.AF_INET,socket.SOCK_STREAM)
    try:
        peer.connect(address);peers={client:peer,peer:client}
        while True:
            ready,_,_=select.select(list(peers),[],[],60)
            if not ready:return
            for source in ready:
                data=source.recv(65536)
                if not data:return
                peers[source].sendall(data)
    except OSError:pass
    finally:client.close();peer.close()
def serve(listener,fn):
    listener.listen(32)
    def accept():
        while True:
            try:client,_=listener.accept()
            except OSError:return
            threading.Thread(target=fn,args=(client,),daemon=True).start()
    threading.Thread(target=accept,daemon=True).start()
entry=socket.socket();entry.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);entry.bind(('127.0.0.1',int(entry_port)))
serve(entry,lambda c:forward(c,control_socket,True))
if int(relay_port):
    relay=socket.socket(socket.AF_UNIX);relay.bind(folder+'/relay.sock')
    serve(relay,lambda c:forward(c,('127.0.0.1',int(relay_port))))
target=subprocess.Popen(['unshare','--net','python3',os.path.join(os.path.dirname(__file__),'network-full-site.py'),folder,marker])
subprocess.run(['ip','link','add','gtyc0','type','veth','peer','name','gtyt0'],check=True)
subprocess.run(['ip','link','set','gtyt0','netns',str(target.pid)],check=True)
for args in [['addr','add','10.88.0.1/30','dev','gtyc0'],['-6','addr','add','fd90::1/64','dev','gtyc0','nodad'],['link','set','gtyc0','up'],['route','add','10.88.0.6/32','via','10.88.0.2','dev','gtyc0']]:subprocess.run(['ip',*args],check=True)
initial={'forwarding':open('/proc/sys/net/ipv4/ip_forward').read().strip(),'forward6':open('/proc/sys/net/ipv6/conf/all/forwarding').read().strip()}
with open(folder+'/initial.json','w') as f:json.dump(initial,f)
diag=socket.socket(socket.AF_UNIX);diag.bind(folder+'/diag.sock')
def diagnose(c):
 try:
  state={'forwarding':open('/proc/sys/net/ipv4/ip_forward').read().strip(),'forward6':open('/proc/sys/net/ipv6/conf/all/forwarding').read().strip(),'links':json.loads(subprocess.run(['ip','-j','link','show'],stdout=subprocess.PIPE).stdout),'rules':subprocess.run(['iptables-save'],stdout=subprocess.PIPE).stdout.decode()}
  try:
   probe=socket.create_connection(('10.88.0.6',19002),timeout=1);probe.sendall(b'negative-control');state['outsideReachable']=bool(probe.recv(100));probe.close()
  except OSError:state['outsideReachable']=False
  state['connectorExit']=process.poll()
  probe=socket.socket();cookie=int.from_bytes(probe.getsockopt(socket.SOL_SOCKET,71,8),sys.byteorder);probe.close()
  lease='/run/wormhole-forward-cookie-'+str(cookie)+'.json'
  try:state['lease']=json.load(open(lease))
  except OSError:state['lease']=None
  c.sendall(json.dumps(state).encode())
 finally:c.close()
serve(diag,diagnose)
process=subprocess.Popen([runtime,'-config',folder+'/connector.json'],cwd=folder)
try:
 while True:
  if os.path.exists(folder+'/stop-connector') and process.poll() is None:process.terminate()
  time.sleep(.1)
finally:
 process.terminate()
 try:process.wait(timeout=6)
 except subprocess.TimeoutExpired:process.kill()
 target.terminate()
