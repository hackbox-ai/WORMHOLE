"""Raw L3 and DNS inside the disposable task network namespace."""
import os,socket,struct,fcntl,json,threading,ipaddress
def read_exact(sock,n):
    chunks=b''
    while len(chunks)<n:
        part=sock.recv(n-len(chunks))
        if not part:raise EOFError()
        chunks+=part
    return chunks
def rpc(path,request):
    s=socket.socket(socket.AF_UNIX);s.settimeout(15);s.connect(path);s.sendall(json.dumps(request).encode()+b'\n')
    line=b''
    while not line.endswith(b'\n'):
        line+=read_exact(s,1)
        if len(line)>8192:raise ValueError('oversized RPC response')
    reply=json.loads(line)
    if not reply.get('ok'):s.close();raise RuntimeError(reply.get('error','jump connection failed'))
    s.settimeout(None);return s,reply
def setup(path,run):
    connection,config=rpc(path,{'op':'packets'})
    tun=os.open('/dev/net/tun',os.O_RDWR)
    fcntl.ioctl(tun,0x400454ca,struct.pack('16sH',b'gtytun0',0x0001|0x1000))
    run('ip','addr','add',config['client'],'dev','gtytun0')
    if config.get('client6'):run('ip','-6','addr','add',config['client6'],'dev','gtytun0','nodad')
    run('ip','link','set','gtytun0','mtu','1400','up')
    run('ip','route','add','default','dev','gtytun0')
    if config.get('client6'):run('ip','-6','route','add','default','dev','gtytun0')
    def upload():
        try:
            while True:
                packet=os.read(tun,65535);connection.sendall(struct.pack('!I',len(packet))+packet)
        except (OSError,EOFError):os._exit(75)
    def download():
        try:
            while True:
                n=struct.unpack('!I',read_exact(connection,4))[0]
                if n<20 or n>65535:raise EOFError()
                os.write(tun,read_exact(connection,n))
        except (OSError,EOFError):os._exit(75)
    threading.Thread(target=upload,daemon=True).start();threading.Thread(target=download,daemon=True).start()
    return connection,tun
def start_dns(path):
    listener=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);listener.bind(('127.0.0.53',53))
    def query(data,peer):
        if len(data)<17:return
        try:
            offset=12;labels=[]
            while data[offset]:
                n=data[offset];offset+=1
                if n>63:raise ValueError()
                labels.append(data[offset:offset+n].decode('ascii'));offset+=n
            end=offset+5
            if end>len(data) or struct.unpack('!H',data[4:6])[0]!=1:raise ValueError()
            kind,cls=struct.unpack('!HH',data[offset+1:end]);host='.'.join(labels)
            conn,response=rpc(path,{'op':'resolve','host':host});conn.close()
            answers=[]
            for raw in response['addresses']:
                ip=ipaddress.ip_address(raw)
                if cls==1 and ((kind==1 and ip.version==4)or(kind==28 and ip.version==6)):
                    answers.append(b'\xc0\x0c'+struct.pack('!HHIH',kind,1,30,len(ip.packed))+ip.packed)
            result=data[:2]+struct.pack('!HHHHH',0x8180,1,len(answers),0,0)+data[12:end]+b''.join(answers)
        except Exception:
            result=data[:2]+struct.pack('!HHHHH',0x8182,1,0,0,0)+data[12:]
        try:listener.sendto(result,peer)
        except OSError:pass
    def loop():
        while True:
            try:data,peer=listener.recvfrom(4096)
            except OSError:return
            threading.Thread(target=query,args=(data,peer),daemon=True).start()
    threading.Thread(target=loop,daemon=True).start()
    return listener
