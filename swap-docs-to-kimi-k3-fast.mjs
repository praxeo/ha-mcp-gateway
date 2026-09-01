// swap-docs-to-kimi-k3-fast.mjs — one-shot doc update (Kimi K3 Fast)
//
// Points CLAUDE.md and README.md model references at Kimi K3 Fast on
// Fireworks. Literal string replacements (no regex); every "old" string
// must occur EXACTLY ONCE or the script aborts without writing anything.
//
// Usage (from repo root):  node swap-docs-to-kimi-k3-fast.mjs
// Not idempotent — after a successful run the old strings are gone.
// Delete this file in the same commit as the doc updates.

import { readFileSync, writeFileSync } from "node:fs";

const OLD_ID = "accounts/fireworks/models/qwen3p8-2p4t-a95b";
// Verify this slug against your Fireworks console before running.
const NEW_ID = "accounts/fireworks/models/kimi-k3-fast";

const EDITS = {
  "CLAUDE.md": [
    // Chat-agent intro line (docs still said GLM 5.2 Fast)
    ['"Ranger," GLM 5.2 Fast on Fireworks', '"Ranger," Kimi K3 Fast on Fireworks'],
    // Model-history sentence tail (current default)
    ["Qwen `qwen3p8-2p4t-a95b`", "Kimi K3 Fast"],
    // LLM-config snippet comment
    ["// Qwen 2.4T-A95B MoE", "// Kimi K3 Fast"],
    // static LLM_MODEL line ID
    [OLD_ID, NEW_ID]
  ],
  "README.md": [
    // "current default" paragraph lead-in
    [
      "The current default is **Qwen `qwen3p8-2p4t-a95b` on Fireworks** with reasoning",
      "The current default is **Kimi K3 Fast on Fireworks** (`" + NEW_ID + "`) with reasoning"
    ],
    // Same paragraph, model description
    ["a large Qwen MoE (~2.4T total / ~95B active)", "Moonshot's fast-tuned Kimi"],
    // Config-line model ID
    [OLD_ID, NEW_ID]
  ]
};

const countOf = (haystack, needle) => haystack.split(needle).length - 1;

// 1) Validate every replacement up front against the original text.
let bad = false;
for (const [file, edits] of Object.entries(EDITS)) {
  const text = readFileSync(file, "utf8");
  for (const [oldStr] of edits) {
    const n = countOf(text, oldStr);
    if (n !== 1) {
      console.error(`FAIL ${file}: expected exactly 1 occurrence, found ${n}:`);
      console.error(`  ${oldStr.slice(0, 80)}${oldStr.length > 80 ? "…" : ""}`);
      bad = true;
    }
  }
}
if (bad) {
  console.error("Aborted — no files written. Fix the anchors above to match current file content.");
  process.exit(1);
}

// 2) Apply + write.
for (const [file, edits] of Object.entries(EDITS)) {
  let text = readFileSync(file, "utf8");
  for (const [oldStr, newStr] of edits) text = text.replace(oldStr, newStr);
  writeFileSync(file, text);
  console.log(`updated ${file}`);
}
console.log("done. Sanity check: git diff --stat && grep -n 'Qwen\|qwen3p8' CLAUDE.md README.md (only historical mentions should remain)");
