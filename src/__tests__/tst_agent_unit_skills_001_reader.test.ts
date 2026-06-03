/**
 * @layer: agent_unit
 * @scenario: stage-4b agent reads installed skills from ~/.magnis/skills/
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  formatSkillsSection,
  loadInstalledSkills,
  type SkillInfo,
} from "../prompts/skills";

function seedSkill(root: string, id: string, body: string): void {
  mkdirSync(join(root, id), { recursive: true });
  writeFileSync(join(root, id, "SKILL.md"), body);
}

describe("Agent skill reader", () => {
  test("tst_agent_unit_skills_001 missing dir yields empty list", () => {
    const skills = loadInstalledSkills("/nonexistent/path/magnis/skills");
    expect(skills).toEqual([]);
  });

  test("tst_agent_unit_skills_002 parses frontmatter name + description", () => {
    const dir = mkdtempSync(join(tmpdir(), "magnis-skills-"));
    seedSkill(
      dir,
      "coach",
      "---\nname: Life Coach\ndescription: Helps the user reflect.\n---\nBody.",
    );
    const skills = loadInstalledSkills(dir);
    expect(skills).toEqual([
      { id: "coach", name: "Life Coach", description: "Helps the user reflect." },
    ]);
  });

  test("tst_agent_unit_skills_003 skills sorted by id; no-frontmatter uses id as name", () => {
    const dir = mkdtempSync(join(tmpdir(), "magnis-skills-"));
    seedSkill(dir, "zz", "---\nname: Zeta\ndescription: Last.\n---\n");
    seedSkill(dir, "aa", "No frontmatter here.");
    const skills = loadInstalledSkills(dir);
    expect(skills.map((s) => s.id)).toEqual(["aa", "zz"]);
    expect(skills[0]).toEqual({ id: "aa", name: "aa", description: "" });
  });

  test("tst_agent_unit_skills_004 directories without SKILL.md are ignored", () => {
    const dir = mkdtempSync(join(tmpdir(), "magnis-skills-"));
    mkdirSync(join(dir, "not-a-skill"), { recursive: true });
    seedSkill(dir, "real", "---\nname: Real\ndescription: OK.\n---\n");
    const skills = loadInstalledSkills(dir);
    expect(skills.map((s) => s.id)).toEqual(["real"]);
  });

  test("tst_agent_unit_skills_005 format empty list returns empty string", () => {
    expect(formatSkillsSection([])).toBe("");
  });

  test("tst_agent_unit_skills_006 format renders one line per skill", () => {
    const skills: SkillInfo[] = [
      { id: "coach", name: "Life Coach", description: "Reflect." },
      { id: "writer", name: "Writer", description: "" },
    ];
    const section = formatSkillsSection(skills);
    expect(section).toContain("SKILLS (installed):");
    expect(section).toContain("- Life Coach: Reflect.");
    expect(section).toContain("- Writer\n");
  });
});
