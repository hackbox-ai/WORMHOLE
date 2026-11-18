#!/usr/bin/env python3
"""Entered through unshare -mnpf. No host network or host service sockets are mounted."""
import os, sys, subprocess, tempfile, shutil, socket, threading, select, signal, json, time
import importlib.util
spec=importlib.util.spec_from_file_location('packet_sandbox',os.path.join(os.path.dirname(__file__),'packet-sandbox.py'))
packet_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(packet_module)
setup,start_dns=packet_module.setup,packet_module.start_dns
sock_path,cwd,ca,command=sys.argv[1:5]
options=json.loads(sys.argv[5]) if len(sys.argv)>5 else {}
cwd=os.path.realpath(cwd)
if os.geteuid()!=0 or not os.path.isdir(cwd) or cwd=='/':
    raise SystemExit('Springboard command required Linux Isolate execution permissions and task working directory')
root=None
host_root=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
chrooted=False
def run(*args):
    subprocess.run(args,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
def bind(source,target,readonly=True):
    dest=root+target
    if os.path.isdir(source): os.makedirs(dest,exist_ok=True)
    else:
        os.makedirs(os.path.dirname(dest),exist_ok=True)
        open(dest,'a').close()
    run('mount','--bind',source,dest)
    if readonly:run('mount','-o','remount,bind,ro',dest)
try:
    # Allocate the staging directory on a private tmpfs, so abrupt namespace death
    # cannot leave directories in the host filesystem.
    sources=[cwd,sock_path,ca,*options.get('mounts',[]),options.get('packetSocket','')]
    staging=next((base for base in ('/tmp','/run','/mnt') if os.path.isdir(base) and not any(p==base or p.startswith(base+'/') for p in sources if p)),None)
    if staging is None:raise RuntimeError('Unable to allocate quarantine temporary directory')
    run('mount','-t','tmpfs','-o','size=32m,mode=755','tmpfs',staging)
    root=tempfile.mkdtemp(prefix='wormhole-net-shell-',dir=staging)
    run('mount','-t','tmpfs','-o','size=32m,mode=755','tmpfs',root)
    bind('/usr','/usr')
    for source in options.get('mounts',[]):
        if os.path.exists(source):bind(source,source)
    for name in ('bin','sbin','lib','lib64'):
        source='/'+name
        if os.path.islink(source):os.symlink(os.readlink(source),root+source)
        elif os.path.exists(source):bind(source,source)
    # Debian shared libraries may resolve through /etc/alternatives.
    for source in ('/etc/ssl/certs','/etc/pki','/etc/alternatives','/etc/ld.so.cache'):
        if os.path.exists(source):bind(source,source)
    for dev in ('null','zero','urandom','random'):
        bind('/dev/'+dev,'/dev/'+dev,False)
    os.makedirs(root+'/proc',exist_ok=True)
    run('mount','-t','proc','proc',root+'/proc')
    os.makedirs(root+'/tmp',mode=0o1777,exist_ok=True);os.chmod(root+'/tmp',0o1777)
    os.makedirs(root+'/run',exist_ok=True)
    bind(sock_path,'/run/wormhole-proxy.sock')
    bind(cwd,cwd,False)
    if ca:bind(ca,ca)
    run('ip','link','set','lo','up')
    if options.get('packetSocket'):
        connection,tun=setup(options['packetSocket'],run)
        bind(options['packetSocket'],'/run/wormhole-packets.sock')
        os.makedirs(root+'/etc',exist_ok=True)
        with open(root+'/etc/resolv.conf','w') as f:f.write('nameserver 127.0.0.53\noptions timeout:2 attempts:1\n')
    else:
        os.makedirs(root+'/etc',exist_ok=True)
        with open(root+'/etc/resolv.conf','w') as f:f.write('nameserver 127.0.0.53\noptions timeout:1 attempts:1\n')
    os.chroot(root);chrooted=True;os.chdir(cwd)
    if options.get('packetSocket'):dns=start_dns('/run/wormhole-packets.sock')
    def forward(client):
        upstream=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        try:
            upstream.connect('/run/wormhole-proxy.sock')
            peers={client:upstream,upstream:client}
            while True:
                ready,_,_=select.select(list(peers),[],[],60)
                if not ready:return
                for source in ready:
                    chunk=source.recv(65536)
                    if not chunk:return
                    peers[source].sendall(chunk)
        except OSError:pass
        finally:client.close();upstream.close()
    listener=socket.socket();listener.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
    listener.bind(('127.0.0.1',18080));listener.listen(32)
    def accept():
        while True:
            try:client,_=listener.accept()
            except OSError:return
            threading.Thread(target=forward,args=(client,),daemon=True).start()
    threading.Thread(target=accept,daemon=True).start()
    def export(port,socket_path):
        while True:
            try:
                probe=socket.create_connection(('127.0.0.1',port),timeout=.2);probe.close();break
            except OSError:time.sleep(.1)
        try:
            os.unlink(socket_path)
        except FileNotFoundError:pass
        # AF_UNIX caps the address bytes, not the backing filesystem path. A directory
        # fd keeps deeply nested task workspaces usable without changing process cwd.
        directory=os.open(os.path.dirname(socket_path),os.O_RDONLY|os.O_DIRECTORY)
        try:
            unix=socket.socket(socket.AF_UNIX)
            unix.bind('/proc/self/fd/'+str(directory)+'/'+os.path.basename(socket_path))
        finally:os.close(directory)
        os.chmod(socket_path,0o600);unix.listen(32)
        def send(client):
            try:
                upstream=socket.create_connection(('127.0.0.1',port),timeout=5);upstream.settimeout(None)
                peers={client:upstream,upstream:client}
                try:
                    while True:
                        ready,_,_=select.select(list(peers),[],[],60)
                        if not ready:return
                        for source in ready:
                            chunk=source.recv(65536)
                            if not chunk:return
                            peers[source].sendall(chunk)
                finally:upstream.close()
            except OSError:pass
            finally:client.close()
        while True:
            try:client,_=unix.accept()
            except OSError:return
            threading.Thread(target=send,args=(client,),daemon=True).start()
    for item in options.get('exports',[]):
        threading.Thread(target=export,args=(int(item['port']),item['socket']),daemon=True).start()
    allowed={'PATH','TERM','LANG','LC_ALL','HOME','http_proxy','https_proxy','all_proxy','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','no_proxy','NO_PROXY','SSL_CERT_FILE','CURL_CA_BUNDLE','REQUESTS_CA_BUNDLE','NODE_EXTRA_CA_CERTS','WORMHOLE_ISOLATED_CHILD_ENV'}
    env={k:v for k,v in os.environ.items() if k in allowed or k.startswith('TOOL_') or k in options.get('envKeys',[])}
    tools_bin=os.path.join(options.get('toolsDir') or '/opt/wormhole/tools','bin')
    env.update({'HOME':cwd,'PATH':tools_bin+':/usr/local/bin:/usr/bin:/usr/sbin:/bin:/sbin'})
    caps=['--bounding-set=-all,+net_raw','--inh-caps=-all,+net_raw','--ambient-caps=-all,+net_raw'] if options.get('packetSocket') else ['--bounding-set=-all','--inh-caps=-all','--ambient-caps=-all']
    # Apply plugin-specific loader variables only after dropping capabilities.
    launch="import os,json,sys; e=dict(os.environ); e.update(json.loads(e.pop('WORMHOLE_ISOLATED_CHILD_ENV','{}'))); os.execvpe('/bin/bash',['/bin/bash','-c',sys.argv[1]],e)"
    result=subprocess.run(['/usr/bin/setpriv',*caps,'--no-new-privs','/usr/bin/python3','-c',launch,command],env=env)
    listener.close()
    raise SystemExit(result.returncode)
finally:
    if chrooted:
        os.fchdir(host_root);os.chroot('.');os.chdir('/')
    if root:
        subprocess.run(['umount','-l',root],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        shutil.rmtree(root,ignore_errors=True)
    os.close(host_root)
