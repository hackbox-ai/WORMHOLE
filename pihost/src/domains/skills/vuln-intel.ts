/** Route public intelligence through the existing Worker Skill grants. */
export function vulnIntelGuidance(agentKey: string, visible: readonly string[]): string {
  if (!['worker', 'pentest'].includes(agentKey) || !visible.includes('wormhole-vuln-intel')) return '';
  return "\n\n## Vulnerability Intelligence Skills\n"
    + "When executing the current intention, first use the fingerprints, PoC candidates and existing facts in the handover package; when encountering product/version, component, CVE or response feature clues, and the local data is not enough to judge the verification method or applicable conditions, call the Skill(name=\"wormhole-vuln-intel\") loading intelligence method; directly reuse when this session has been loaded.\n"
    + "Supplement the public information as needed and return to the current intent verification. Use record_fact to write back the source, applicable conditions and actual results for the main Agent to continue arranging. Verify directly when there is sufficient data; record the gap when the retrieval fails or the quota is insufficient, and continue other executable checks without using retrieval as a prerequisite for starting or completing the task.\n";
}
