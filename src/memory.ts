/**
 * Persistent memory system for WeChat Claude Bot.
 *
 * Each user gets a memory file (~/.weixin-claude-bot/memories/<userId>.md).
 * - Before each Claude call, memory is loaded and appended to the system prompt.
 * - After each response, Claude's suggested memory updates are extracted and saved.
 *
 * Memory format: condensed markdown with key facts about the user and past conversations.
 * Claude is instructed to output <!-- MEMORY: ... --> blocks for new facts.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const MEMORIES_DIR = path.join(os.homedir(), ".weixin-claude-bot", "memories");

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Hash userId to create a safe filename */
function hashUserId(userId: string): string {
  return crypto.createHash("sha256").update(userId).digest("hex").substring(0, 16);
}

function memoryFilePath(userId: string): string {
  return path.join(MEMORIES_DIR, `${hashUserId(userId)}.md`);
}

/**
 * Load a user's long-term memory.
 * Returns content as string, or empty if none.
 */
export function loadMemory(userId: string): string {
  try {
    return fs.readFileSync(memoryFilePath(userId), "utf-8").trim();
  } catch {
    return "";
  }
}

/**
 * Save updated memory for a user.
 */
export function saveMemory(userId: string, content: string): void {
  ensureDir(MEMORIES_DIR);
  fs.writeFileSync(memoryFilePath(userId), content.trim() + "\n");
  console.log(`  [memory] saved (${hashUserId(userId)}.md, ${content.length} chars)`);
}

/**
 * Clear a user's memory.
 */
export function clearMemory(userId: string): void {
  try {
    fs.unlinkSync(memoryFilePath(userId));
    console.log(`  [memory] cleared (${hashUserId(userId)}.md)`);
  } catch {
    // OK
  }
}

/**
 * Extract memory blocks from Claude's response.
 * Claude outputs <!-- MEMORY: ... --> for new facts.
 * These are stripped from the response sent to the user.
 *
 * Returns { cleanText, newMemories }.
 */
export function extractMemoryUpdates(text: string): { cleanText: string; newMemories: string[] } {
  const blocks: string[] = [];
  const regex = /<!--\s*MEMORY:\s*([\s\S]*?)\s*-->/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const content = match[1].trim();
    if (content) blocks.push(content);
  }

  // Remove memory blocks from output
  const cleanText = text.replace(/<!--\s*MEMORY:\s*[\s\S]*?\s*-->/g, "").trim();

  return { cleanText, newMemories: blocks };
}

/**
 * Build the memory prompt section: prepend existing memory + memory update instruction.
 */
export function buildMemoryPromptParts(memory: string): { memoryPrompt: string; updateInstruction: string } {
  const memoryPrompt = memory
    ? `\n\n[历史记忆]\n以下是关于用户和你之前对话中记住的信息，请基于这些信息回应用户：\n\n${memory}\n`
    : "";

  const updateInstruction =
    "\n\n[记忆更新指令]\n如果你在这次对话中了解到任何关于用户的重要新信息（偏好、事实、约定等），\n请在回复末尾添加：\n<!-- MEMORY: 你记住的信息 -->\n\n" +
    "例如：\n<!-- MEMORY: 用户喜欢简洁的回答 -->\n<!-- MEMORY: 用户的工作是软件工程师 -->\n\n" +
    "不要重复已经记住的信息。如果没有新信息需要记住，就不要输出记忆块。";

  return { memoryPrompt, updateInstruction };
}
