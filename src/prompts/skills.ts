/**
 * Agent-side reader for installed skills.
 *
 * Optional capability: when `AGENT_SKILLS_DIR` is configured, the agent
 * scans `{AGENT_SKILLS_DIR}/<id>/SKILL.md`, parses each SKILL.md's YAML
 * frontmatter, and surfaces the installed skills in the system prompt.
 * When the env var is unset, no skills section is produced (opt-in).
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

export interface SkillInfo {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

/** Configured skills directory, or `undefined` when the feature is off. */
export function skillsDir(): string | undefined {
  return process.env.AGENT_SKILLS_DIR || undefined;
}

export function loadInstalledSkills(dir?: string): SkillInfo[] {
  const root = dir ?? skillsDir();
  if (!root) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const skills: SkillInfo[] = [];
  for (const id of entries) {
    if (id.startsWith(".")) continue;
    const skillFile = join(root, id, "SKILL.md");
    try {
      if (!statSync(skillFile).isFile()) continue;
    } catch {
      continue;
    }
    const text = readFileSync(skillFile, "utf-8");
    const { name, description } = parseFrontmatter(text, id);
    skills.push({ id, name, description });
  }
  skills.sort((a, b) => a.id.localeCompare(b.id));
  return skills;
}

function parseFrontmatter(
  text: string,
  fallbackId: string,
): { name: string; description: string } {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return { name: fallbackId, description: "" };
  const block = m[1];
  const name = (/^name:\s*(.+)$/m.exec(block)?.[1] ?? fallbackId).trim();
  const description = (/^description:\s*(.+)$/m.exec(block)?.[1] ?? "").trim();
  return { name, description };
}

export function formatSkillsSection(skills: readonly SkillInfo[]): string {
  if (skills.length === 0) return "";
  let out = "SKILLS (installed):\n";
  for (const s of skills) {
    out += s.description ? `- ${s.name}: ${s.description}\n` : `- ${s.name}\n`;
  }
  out += "Invoke a skill when the task matches its description.\n\n";
  return out;
}
