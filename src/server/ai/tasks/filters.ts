import { z } from "zod";
import type { Q } from "../../db";
import { runTask, type AiLogTarget } from "../run";
import { CMPS, FIELD_DEFS, FIELD_KEYS, describeFilter, parseNaturalLanguage, type FilterNode } from "../../domain/filters";
import { CATEGORY_KEYS, NIGERIAN_CITIES } from "../../domain/taxonomy";

const output = z.object({
  conditions: z
    .array(z.object({ field: z.enum(FIELD_KEYS), cmp: z.enum(CMPS), value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]) }))
    .max(12),
  explanation: z.array(z.string().max(120)).max(12),
});

/** Natural language → filter tree using AI, constrained to the field whitelist. */
export async function parseFilterWithAi(q: AiLogTarget, workspaceId: string, text: string): Promise<{ filter: FilterNode; explanation: string[]; source: string } | null> {
  const res = await runTask(q, workspaceId, {
    task: "filter.parse",
    input: text,
    output,
    system: "You convert a description of target businesses into database filter conditions (all ANDed). Use only the listed fields, comparisons and values. Do not guess conditions the user didn't ask for.",
    maxTokens: 500,
    temperature: 0,
    buildPrompt: (t) => `Fields: ${FIELD_KEYS.map((k) => `${k} (${FIELD_DEFS[k].type})`).join(", ")}
Comparisons: ${CMPS.join(", ")}. Booleans use is_true / is_false with value null.
Category values: ${CATEGORY_KEYS.join(", ")}
City values: ${NIGERIAN_CITIES.map((c) => c.name).join(", ")}

Description: "${t}"`,
    validate: (o) => {
      for (const c of o.conditions) {
        if (c.field === "category") {
          const vals = Array.isArray(c.value) ? c.value : [String(c.value)];
          const bad = vals.find((v) => !CATEGORY_KEYS.includes(v as never));
          if (bad) return `Unknown category "${bad}".`;
        }
      }
      return null;
    },
    fallback: (t) => {
      const r = parseNaturalLanguage(t);
      return { conditions: [], explanation: r.explanation };
    },
  });
  if (res.usedFallback || res.output.conditions.length === 0) return null;
  const filter: FilterNode = {
    op: "and",
    children: res.output.conditions.map((c) => ({ field: c.field, cmp: c.cmp, ...(c.value === null ? {} : { value: c.value }) })),
  };
  return { filter, explanation: res.output.explanation.length ? res.output.explanation : [describeFilter(filter)], source: res.source };
}
