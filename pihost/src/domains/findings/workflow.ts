/**
 * F04 Discovery Workflow：
 * - deepen：Add follow-up intention Independent conversation and conclusion transaction of（AddFindingFollowUpIntent）
 * - retests：See retests.ts independent conversation and conclusion transactions
 * - export：Export JSON/CSV
 */
import type { Pool } from "pg";
import {deepenFinding,type FindingTaskHost,type FollowUpResult} from './follow-up.ts';

export class FindingsWorkflow {
  constructor(
    private readonly pool: Pool,
    private readonly dlqPath: string,
    private readonly taskHost?: FindingTaskHost,
  ) {}

  /** POST /api/exploration/findings/{id}/deepen — Add follow-up exploration intention (cf. deepenFinding） */
  async deepen(findingId: number, description: string): Promise<FollowUpResult> {
    return deepenFinding(this.pool,this.taskHost,findingId,description);
  }

  /** GET /api/exploration/findings/export — JSON Export */
  async export(filter: { severity?: string; status?: string } = {}): Promise<Record<string, unknown>[]> {
    const where: string[] = ["TRUE"];
    const args: unknown[] = [];
    if (filter.severity) { args.push(filter.severity); where.push(`severity=$${args.length}`); }
    if (filter.status) { args.push(filter.status); where.push(`status=$${args.length}`); }
    return (await this.pool.query(
      `SELECT id, task_id, name, vulnclass, severity, status, summary, worker, created_at
       FROM findings WHERE ${where.join(" AND ")} ORDER BY id`,
      args,
    )).rows;
  }
}
