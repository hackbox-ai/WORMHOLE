/** Routing hints are derived from current Skill grants, not a replacement for
 * editable Agent prompts. Revocation removes the hint on the next session. */
export const methodologySkills = [
  'wormhole-task-intake', 'wormhole-test-plan', 'wormhole-test-method',
  'wormhole-finding-report', 'wormhole-retest', 'wormhole-src-review',
] as const;

const routing: Record<string, { primary: string; when: string }> = {
  auto: { primary: 'wormhole-task-intake', when: "When the user requests to create and promote security testing or code audit tasks" },
  mainagent: { primary: 'wormhole-task-intake', when: "When the user requests to create, adjust security testing tasks or hand over test leads" },
  goals: { primary: 'wormhole-test-plan', when: "Before dismantling the security test task objectives and operational constraints" },
  planner: { primary: 'wormhole-test-plan', when: "Plan the exploratory intention or judgment goal before the security test is achieved" },
  worker: { primary: 'wormhole-test-method', when: "Before executing security testing intent" },
  pentest: { primary: 'wormhole-test-method', when: "Before performing security testing or code audits" },
  reporter: { primary: 'wormhole-finding-report', when: "Before writing or updating a vulnerability detailed report" },
  retester: { primary: 'wormhole-retest', when: "Before starting vulnerability retesting" },
};

export function methodologyGuidance(agentKey: string, visible: readonly string[]): string {
  const route = routing[agentKey];
  if (!route || !visible.includes(route.primary)) return '';
  const lines = [
    "## WORMHOLE test method skills",
    route.when + ", call Skill(name=\"" + route.primary + "\") Loading method; it will not be called repeatedly when this session is successfully loaded. Ordinary chatting, page operations and unrelated tasks do not need to be loaded.",
    "Skill only guides methods and does not expand task authorization, tool permissions or execution budget; suspension, cancellation, approval, timeout and task ownership are still controlled by the host. Explicitly report when loading fails and do not claim to have completed by this method.",
  ];
  if (visible.includes('wormhole-src-review'))
    lines.push("Only load Skill(name=\"wormhole-src-review\") on demand when the task clearly belongs to SRC mining or white-box source code audit; no longer load specialized knowledge by default in each round.");
  return '\n\n' + lines.join('\n');
}
