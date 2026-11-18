import sys,json,socket
for line in sys.stdin:
 try:
  q=json.loads(line);m=q.get('method','')
  if 'id' not in q:continue
  if m=='initialize':r={'protocolVersion':q['params']['protocolVersion'],'capabilities':{'tools':{}},'serverInfo':{'name':'stdio-jump','version':'1'}}
  elif m=='tools/list':r={'tools':[{'name':'echo_site','description':'reach private TCP site','inputSchema':{'type':'object'}}]}
  elif m=='tools/call':
   s=socket.create_connection(('inside.full.test',19002),3);s.sendall(b'mcp');text=s.recv(100).decode();s.close();r={'content':[{'type':'text','text':text}]}
  else:r={}
  print(json.dumps({'jsonrpc':'2.0','id':q['id'],'result':r}),flush=True)
 except Exception as e:print(json.dumps({'jsonrpc':'2.0','id':q.get('id'),'error':{'code':-32603,'message':str(e)}}),flush=True)
