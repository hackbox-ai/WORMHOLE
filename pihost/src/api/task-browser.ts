import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppContext } from "./server.ts";
import { readObject } from "./json-body.ts";

export async function routeTaskBrowser(
  req: IncomingMessage, res: ServerResponse, url: URL, ctx: AppContext,
  json: (res: ServerResponse, status: number, body: unknown) => void,
) {
  const match = /^\/api\/tasks\/([1-9]\d*)\/browser(?:\/([a-f0-9-]{36}))?$/.exec(url.pathname);
  if (!match) return false;
  const taskId = Number(match[1]);
  if (!ctx.taskBrowsers || !Number.isSafeInteger(taskId)) {
    json(res, 404, { error: "Task browser is unavailable" });
  } else if (req.method === "GET" && !match[2]) {
    try{json(res,200,await ctx.taskBrowsers.workspace(taskId));}catch(e){json(res,404,{error:(e as Error).message});}
  } else if(req.method==="POST"&&!match[2]){
    try{json(res,200,await ctx.taskBrowsers.humanOpen(taskId,await readObject(req,8192,true)));}
    catch(e){json(res,409,{error:(e as Error).message.split("\n")[0]});}
  } else if (req.method === "POST" && match[2]) {
    try {
      const params = await readObject(req, 8192, true);
      json(res, 200, await ctx.taskBrowsers.humanAction(taskId, match[2], String(params?.action), params ?? {}));
    } catch (error) {
      json(res, 409, { error: error instanceof Error ? error.message.split("\n")[0] : "Browser operation failed" });
    }
  } else {
    json(res, 405, { error: "method not allowed" });
  }
  return true;
}
