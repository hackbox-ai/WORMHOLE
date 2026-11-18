/**
 * B08 固定模型响应夹具：本地 Anthropic messages 兼容 mock。
 * 事件形状 1:1 复刻真实 GLM(anthropic 兼容端点) 的 SSE 录制样本
 * （/tmp/glm-sse-captured.txt，经录制代理采样），含 ping/thinking/text
 * 双 content block 与完整 message_delta —— 避免格式差异导致解析中断。
 */
import { createServer, type Server } from "node:http";

export interface MockState {
  calls: { path: string; stream: boolean; body?: Record<string, unknown> }[];
  failuresLeft: number;
  marker: string;
}

export interface ToolCallSpec {
  name: string;
  /** 工具入参（对象；以 partial_json 整体下发） */
  input: Record<string, unknown>;
}

/**
 * opts.toolCalls：确定性工具调用序列——第 i 次请求返回第 i 个 tool_use 块
 * （Anthropic tool_use SSE），序列耗尽后回落文本 marker。用于全纵切：真实 Pi
 * 会话路径由模型输出驱动工具执行。
 */
export function startMockAnthropic(
  port: number,
  opts: { truncate?: (body:Record<string,unknown>,call:number)=>boolean; failFirst?: number; marker?: string; streamError?:{type:string;message:string}; toolCalls?: ToolCallSpec[]; graphWorkflow?: boolean; tool?: (body: Record<string, unknown>, call: number) => ToolCallSpec|undefined; delayMs?: number; responseBarrier?:Promise<void>; text?: (body: Record<string, unknown>, call: number) => string } = {},
): Promise<{ server: Server; state: MockState }> {
  const state: MockState = { calls: [], failuresLeft: opts.failFirst ?? 0, marker: opts.marker ?? "MOCK_OK" };
  // 带工具请求的独立计数：planner（无工具）拿文本，worker（带工具）按序拿 tool_use
  let withToolsCount = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      state.calls.push({ path: req.url ?? "", stream: parsed.stream === true, body: parsed });
      const n = state.calls.length;
      const respond = () => {
      if (res.destroyed) return;
      if (state.failuresLeft > 0) {
        state.failuresLeft -= 1;
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ type: "error", error: { type: "api_error", message: `mock failure #${state.calls.length}` } }),
        );
        return;
      }
      const marker = opts.text ? opts.text(parsed, n) : `${state.marker}_${n}`;
      const hasTools = /"tools"\s*:\s*\[\{/.test(body);
      const names=((parsed.tools??[]) as {name:string}[]).map(t=>t.name);
      // Fixed toolCalls sequences belong to workers, not planners/goals.
      const modeler=names.includes('api_model_submit');
      const worker=!modeler&&(names.includes('http_request')||names.includes('insert_assets'));
      if (worker) withToolsCount += 1;
      let toolCall = opts.tool ? opts.tool(parsed,n) : worker ? opts.toolCalls?.[withToolsCount - 1] : undefined;
      if(modeler&&!toolCall){
        const messages=parsed.messages as {content:{type:string;name?:string}[]}[];
        const used=(name:string)=>messages.some(m=>m.content.some(c=>c.type==='tool_use'&&c.name===name));
        if(!used('api_model_submit'))toolCall={name:'api_model_submit',input:{paths:{'/fixture':{get:{summary:'fixture endpoint',responses:{'200':{description:'fixture response'}},'x-wormhole-evidence':'synthetic test fixture'}}}}};
        else if(!used('api_model_done'))toolCall={name:'api_model_done',input:{summary:'仅覆盖本地协议夹具接口；无真实目标探测或验证'}};
      }
      if(opts.graphWorkflow&&!modeler){
        const messages=parsed.messages as {role:string;content:{type:string;text?:string;name?:string}[]}[],last=messages.at(-1);
        const userText=last?.content.filter(c=>c.type==='text').map(c=>c.text??'').join('')??'';
        const result=last?.content.some(c=>c.type==='tool_result');
        if(names.includes('prove_goal')&&!result){
          const overview=JSON.parse(userText.split('任务探索图概览：\n')[1]!.split('\n操作约束：')[0]!);
          const fact=overview.recent_facts.find((f:{state:string})=>f.state==='confirmed');
          if(fact)toolCall={name:'prove_goal',input:{goal_id:overview.goals[0].id,evidence_id:fact.id,reason:'fixture execution verified'}};
          else if(!overview.open_intents.length&&!overview.running_intents.length&&!overview.done_intents_total)toolCall={name:'add_intent',input:{summary:'fixture direction',priority:5}};
        }else if(names.includes('set_goals')&&!names.includes('add_hint')&&!result)toolCall={name:'set_goals',input:{text:'fixture execution verified'}};
        else if(worker&&!toolCall&&(!result||!messages.some(m=>m.content.some(c=>c.type==='tool_use'&&c.name==='record_fact'))))
          toolCall={name:'record_fact',input:{summary:'fixture execution verified',evidence:'deterministic mock results',confidence:'observed'}};
      }
      const wantsStream = parsed.stream === true;
      if (!wantsStream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: `msg_mock_${n}`,
            type: "message",
            role: "assistant",
            model: "mock-1",
            content: [{ type: "text", text: marker }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 11, output_tokens: 7 },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (name: string, data: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      ev("message_start", {
        type: "message_start",
        message: {
          id: `msg_mock_${n}`,
          type: "message",
          role: "assistant",
          model: "mock-1",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      ev("ping", { type: "ping" });
      if(opts.truncate?.(parsed,n)){
        ev('content_block_start',{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'',signature:''}});
        ev('content_block_delta',{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'budget exhausted before any tool call'}});
        ev('content_block_stop',{type:'content_block_stop',index:0});
        ev('message_delta',{type:'message_delta',delta:{stop_reason:'max_tokens',stop_sequence:null},usage:{input_tokens:30000,output_tokens:8192}});
        ev('message_stop',{type:'message_stop'});res.end();return;
      }
      if (toolCall) {
        ev("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: `toolu_${n}`, name: toolCall.name, input: {} },
        });
        ev("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(toolCall.input) },
        });
        ev("content_block_stop", { type: "content_block_stop", index: 0 });
        ev("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { input_tokens: 11, output_tokens: 7 },
        });
        ev("message_stop", { type: "message_stop" });
        res.end();
        return;
      }
      ev("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "mock thinking" } });
      ev("content_block_stop", { type: "content_block_stop", index: 0 });
      ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: marker } });
      ev("content_block_stop", { type: "content_block_stop", index: 1 });
      if(opts.streamError){ev('error',{type:'error',error:opts.streamError});res.end();return;}
      ev("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 11, output_tokens: 7 },
      });
      ev("message_stop", { type: "message_stop" });
      res.end();
      };
      // 测试辅助：延迟响应以持住运行中的会话（生命周期/取消测试用）
      if(opts.responseBarrier)void opts.responseBarrier.then(respond);
      else if (opts.delayMs && opts.delayMs > 0) setTimeout(respond, opts.delayMs);
      else respond();
    });
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({ server, state }));
  });
}
