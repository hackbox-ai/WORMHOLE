// 极简 MCP stdio mock：逐行读 JSON-RPC，应答 initialize 与 tools/list
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method === "initialize") {
      write({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} },serverInfo:{name:'mock',version:'1'} } });
    } else if (msg.method === "tools/list") {
      write({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: [
            { name: "mock_echo", description: "echo a value", inputSchema: { type: "object", properties: { v: { type: "string" } } } },
            { name: "mock_ping", description: "ping", inputSchema: { type: "object" } },
          ],
        },
      });
    } else if(msg.method==='tools/call'){
      if(msg.params.name==='mock_echo'){
        const result={content:[{type:'text',text:`echo:${msg.params.arguments?.v??''}`}],structuredContent:{v:msg.params.arguments?.v??''}};
        if(msg.params.arguments?.v==='slow')setTimeout(()=>write({jsonrpc:'2.0',id:msg.id,result}),2_000);
        else write({jsonrpc:'2.0',id:msg.id,result});
      }else write({jsonrpc:'2.0',id:msg.id,result:{content:[{type:'text',text:'remote failure'}],isError:true}});
    }
  }
});
function write(o){process.stdout.write(JSON.stringify(o)+"\n");}
