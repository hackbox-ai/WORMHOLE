/**
 * P4 Coverage Classifier（G15 Revised version, control OWNER-PARITY-REVIEW §G15）。
 * Separation of classification and evidence：
 * - route-exists-verified：Parameter routing with ”real created resource” 200 + The resource clearly does not exist 404」
 *   Double exploration confirmed（evidence.resourceVerified）。Synthesis id of 404 Can only be counted param-404-unverified，
 *   It cannot be because URI With placeholder, it is assumed that the route has been implemented。
 * - sse-entry-only：SSE content-type Only proves the existence of the entrance; events and disconnection playback are not available before verification。
 * - 502 Always failed (upstream errors are also errors and are no longer included in the validation）。
 * accepted / scenario-passed It is always determined by the evidence chain outside the script, and this classifier does not determine。
 */

export type CoverageState =
  | "first-slice-usable"
  | "route-exists-verified"
  | "route-exists-validation"
  | "param-404-unverified"
  | "sse-entry-only"
  | "explicit-not-migrated"
  | "auth-fail"
  | "no-route"
  | "server-error"
  | "shape-mismatch";

export interface RouteCoverage {
  route: string;
  status: number;
  state: CoverageState;
  detail?: string;
}

/** Required query Routing of parameters：404 = Resource does not exist (route exists） */
const QUERY_PARAM_ROUTES = new Set(["/api/traffic/exchange", "/api/traffic/blob", "/api/workspace/read", "/api/workspace/list", "/api/workspace/download", "/api/logs/history", "/api/exploration/activity", "/api/exploration/activity-history"]);

const SHAPE_CHECKS: Record<string, (body: unknown) => string | null> = {  "/api/stats": (b) => {
    if(!b||typeof b!=='object'||Array.isArray(b))return "Expected a JSON object";
    const keys = Object.keys(b as object);
    for (const k of ["asset_counts", "assets", "engine_mode", "llm_configured", "traffic", "traffic_enabled"]) {
      if (!keys.includes(k)) return `Missing field ${k}`;
    }
    return null;
  },
  "/api/settings": (b) => {
    if(!b||typeof b!=='object'||Array.isArray(b))return "Expected a JSON object";
    const required=['traffic_capture','agent_traffic_binding','llm_record','web_search_enabled','web_search_backend','web_search_proxy','global_proxy','python_interpreter','workers','task_concurrency_enabled','task_concurrency_limit','llm_pool_enabled','llm_pool_bind_fallback','constraints_inject_planner','constraints_inject_worker','noa_compaction','notify_enabled','notify_public_base_url','notify_digest_interval_min','brave_search_api_key_set','tavily_search_api_key_set'];
    for(const key of required)if(!Object.hasOwn(b,key))return "Missing field "+key;
    return null;
  },
  "/api/agents": (b) => { const list = Array.isArray(b) ? b : (b as { agents?: unknown[] })?.agents; return Array.isArray(list) && list.length >= 8 ? null : "The built-in agent seed is missing"; },
  "/api/tools": (b) => { const list = Array.isArray(b) ? b : (b as { tools?: unknown[] })?.tools; return Array.isArray(list) ? null : "Expected an array (or {tools:[...]} wrapper)"; },
};

export interface RouteEvidence {
  contentType?:string;
  /** Parameter routing confirmed with real resource round trip (real id Got 200/2xx and does not exist id Got 404） */
  resourceVerified?: boolean;
  /** SSE Verified event flow and disconnection playback（cursor/Last-Event-ID There are events in replay） */
  sseVerified?: boolean;
}

export function classifyRoute(route: string, status: number, bodyText: string, evidence: RouteEvidence = {}): RouteCoverage {
  let detail: string | undefined;
  let state: CoverageState;
  const isParamRoute = route.includes("{") || QUERY_PARAM_ROUTES.has(route);
  if (status === 501) {
    state = "explicit-not-migrated";
  } else if (status === 401) {
    state = "auth-fail";
    detail = "Still 401 with valid token";
  } else if (status === 404) {
    if (isParamRoute) {
      if (evidence.resourceVerified) {
        state = "route-exists-verified";
        detail = "Parameter routing: real resource 200 + non-existent id 404 double probe passed";
      } else {
        state = "param-404-unverified";
        detail = "Parameter route synthesis id 404: It only proves that the URI is reachable, and double exploration of real resources is required before the route exists.";
      }
    } else {
      state = "no-route";
      detail = "No Parameter Route 404: Route does not exist";
    }
  } else if (status === 400 || status === 403 || status === 405 || status === 409 || status === 413) {
    state = "route-exists-validation";
    detail = `Verification response ${status}`;
  } else if (status >= 500) {
    state = "server-error";
    detail = bodyText.slice(0, 120);
  } else if (status >= 200 && status < 300) {
    if(evidence.contentType?.includes('text/event-stream')&&!evidence.sseVerified)return {route,status,state:'sse-entry-only',detail:"SSE Portal (Event/Replay Not Validated)"};
    state = "first-slice-usable";
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      detail = "Non-JSON response";
    }
    const check = SHAPE_CHECKS[route];
    if (check) {
      const err = check(parsed);
      if (err) {
        state = "shape-mismatch";
        detail = err;
      }
    }
  } else {
    state = "server-error";
    detail = `Unexpected status code ${status}`;
  }
  return { route, status, state, detail };
}

export interface CoverageSummary {
  total: number;
  /** Available = 2xx First slice + Verification response + Parameter routing confirmed by double exploration of real resources（G15：Synthesis 404/SSE Entrance no longer counts） */
  firstSliceUsable: number;
  routeExistsTotal: number; // census Registration means it exists (only registration does not mean implementation）
  explicitNotMigrated: number;
  /** Pending evidence: synthesis 404 Not double explored / SSE Entrance only. Not considered usable, not considered a failure。 */
  pendingEvidence: { param404Unverified: number; sseEntryOnly: number };
  failures: { authFail: number; noRoute: number; serverError: number; shapeMismatch: number };
  accepted: number;
  acceptedNote: string;
}

export function summarize(routes: RouteCoverage[]): { summary: CoverageSummary; routes: RouteCoverage[] } {
  const count = (s: CoverageState) => routes.filter((r) => r.state === s).length;
  const usable = count("first-slice-usable") + count("route-exists-verified") + count("route-exists-validation");
  return {
    summary: {
      total: routes.length,
      firstSliceUsable: usable,
      routeExistsTotal: routes.length,
      explicitNotMigrated: count("explicit-not-migrated"),
      pendingEvidence: {
        param404Unverified: count("param-404-unverified"),
        sseEntryOnly: count("sse-entry-only"),
      },
      failures: {
        authFail: count("auth-fail"),
        noRoute: count("no-route"),
        serverError: count("server-error"),
        shapeMismatch: count("shape-mismatch"),
      },
      accepted: 0,
      acceptedNote: "Acceptance needs to be combined with API, data, side effects and fault recovery evidence. This script only provides coverage classification",
    },
    routes,
  };
}
