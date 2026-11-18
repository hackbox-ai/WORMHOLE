import type { Pool } from "pg";
import { registerTool } from "../tools/gate.ts";
import {BrowserTargetError, type TaskBrowsers} from "./task-browser.ts";

export const BROWSER_GUIDANCE = "The task browser belongs to the task. First use task_browser(action=list) to view the existing environment and tab pages, and reuse the environment handed over by the user. environment_id/tab_id is used for browsers; browser_environment of http_request is used for current request authentication. waiting_for_user means waiting for a manual handover, continuing in the other direction instead of retrying or creating an alternative environment to bypass the takeover. Anonymous/different accounts use new_environment to create independent environments. \nWhen the browser clearly returns status=blocked and retryable=false, it is not allowed to sleep and retry, rewrite the URL, or use registered assets to expand authorization; record the blockage and continue other executable checks, and report the gap after saving the evidence. Use task_browser's fill(action,selector,text) to fill in the form, and cannot use HTTP requests to impersonate browser operations.\n";
export const TASK_BROWSER_TOOL = "task_browser";
const description = "Task Browser manages multiple isolation environments and tabs by task. First, list the environment to be handed over by the user, using environment_id/tab_id; new_tab is the shared environment login state, open creates a new environment if there is no match. When waiting_for_user, continue other checks, wait for handover, and retry without looping. HTTP requests can be passed to browser_environment to use the authentication of the handed-over environment. Managed browser that operates the current task: open/navigate, snapshot, fill, click, close, publish_auth, crawl. open can pass identity to reuse the published login state of the same task. When manual login is required, request_login is called, and the user can directly enter the browser to take over from the task dialog. The crawl page-by-page registration interface is used by Planner and Worker.";
const schema = {
  type: "object",
  properties: {
    action: { type: "string", description: "request_login waits for user to take over and hand it back, up to 90 seconds.", enum: ["list", "new_environment", "new_tab", "close_tab", "open", "navigate", "snapshot", "fill", "click", "close", "publish_auth", "request_login", "crawl"] },
    environment_id:{type:"string",format:"uuid"},
    tab_id:{type:"string",format:"uuid"},
    name:{type:"string",maxLength:50},
    url: { type: "string", maxLength: 2048 },
    selector: { type: "string", maxLength: 512 },
    text: { type: "string", maxLength: 4096, description: "Input content of fill" },
    identity: { type: "string", maxLength: 50 },
    path: { type: "string", maxLength: 512 },
    limit: { type: "integer", minimum: 1, maximum: 10 },
  },
  required: ["action"],
  additionalProperties: false,
};

export async function registerTaskBrowserTool(pool: Pool, browsers: TaskBrowsers) {
  const conflict = await pool.query("SELECT 1 FROM tools WHERE key=$1 AND NOT system", [TASK_BROWSER_TOOL]);
  if (conflict.rowCount) throw new Error("Task Browser tool name conflicts with custom tool");
  await pool.query(
    "INSERT INTO tools(key,description,schema,agents,system,kind) VALUES($1,$2,$3,$4,TRUE,'builtin') ON CONFLICT(key) DO UPDATE SET schema=EXCLUDED.schema,description=CASE WHEN tools.description LIKE 'Operate the managed browser of the current task: %' THEN EXCLUDED.description ELSE tools.description END WHERE tools.system",
    [TASK_BROWSER_TOOL, description, JSON.stringify(schema), JSON.stringify(["worker"])],
  );
  registerTool({ key: TASK_BROWSER_TOOL, description, schema, params: {}, required: [],
    execute: async (params, ctx) => {
      try{return await browsers.execute(ctx, params);}
      catch(error){
        if(!(error instanceof BrowserTargetError))throw error;
        return {status:'blocked',code:error.code,retryable:false,message:error.message};
      }
    } });
}
