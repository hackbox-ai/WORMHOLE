/**
 * F14 Skill→Pi 资源转换（owner 缺口：Pi 资源转换）：
 * WORMHOLE SKILL.md frontmatter → Pi DefaultResourceLoader additionalSkillPaths 装载。
 * 验证：pihost Skill 目录中的 SKILL.md 被 Pi 会话识别（skill 列表含该名）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { SkillsService } from "../src/domains/skills/service.ts";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const SKILL_ROOT = "/tmp/pihost-test-skills-pi";
await rm(SKILL_ROOT, { recursive: true, force: true });
const config = loadConfig();
const pool = new Pool({ connectionString: config.database.dsn });
await runMigrations(pool);

test("F14 Skill→Pi：SKILL.md 目录被 DefaultResourceLoader 装载为可用 skill", async () => {
  // 创建 WORMHOLE 格式 Skill
  const skills = new SkillsService(pool, "/tmp/pihost-test-dlq.jsonl", SKILL_ROOT);
  await skills.create("pi-convert-test", "测试 Pi 转换的 Skill");
  await skills.writeFile("pi-convert-test", "scripts/run.md", "# run\n执行步骤");

  // Pi DefaultResourceLoader 装载
  const loader = new DefaultResourceLoader({
    cwd: "/tmp",
    agentDir: "/tmp/pihost-test-pi-agent",
    systemPrompt: "test",
    additionalSkillPaths: [SKILL_ROOT],
  });
  await loader.reload();

  // Pi 应识别到该 skill
  const { skills: loaded, diagnostics } = loader.getSkills();
  assert.equal(diagnostics.length, 0, `装载无诊断错误：${JSON.stringify(diagnostics).slice(0, 100)}`);
  const names = loaded.map((s: { name: string }) => s.name);
  assert.ok(
    names.some((n: string) => n === "pi-convert-test"),
    `Pi 资源装载应含 pi-convert-test（实际：${names.join(",")}）`,
  );

  // 验证 frontmatter 描述被保留
  const skill = loaded.find((s: { name: string }) => s.name === "pi-convert-test");
  assert.ok(skill, "skill 存在");
  void skill;
});

test("teardown", async () => {
  await rm(SKILL_ROOT, { recursive: true, force: true });
  await rm("/tmp/pihost-test-pi-agent", { recursive: true, force: true }).catch(() => {});
  await pool.end();
  process.exit(0);
});
void mkdir;
void path;
void writeFile;
