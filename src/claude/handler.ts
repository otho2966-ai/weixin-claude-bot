/**
 * Claude Code integration (Direct subprocess mode).
 * Processes WeChat messages through Claude Code and returns text responses.
 *
 * 改用直接子进程模式（绕过 SDK 的 query() 协议层），
 * 避免 SDK 协议模式下内部分类器调用因代理响应缺少 usage 字段而崩溃的问题。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BotConfig } from "../store.js";
import {
  loadMemory,
  saveMemory,
  extractMemoryUpdates,
  buildMemoryPromptParts,
  clearMemory,
} from "../memory.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Set git-bash path for Windows Claude Code subprocess
process.env.CLAUDE_CODE_GIT_BASH_PATH = "D:\\Program Files\\Git\\bin\\bash.exe";
process.env.CLAUDE_CODE_SIMPLE = "1";               // 简化模式，减少内部逻辑
process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";   // 禁用自动记忆

export type ClaudeResponse = {
  text: string;
  durationMs: number;
  costUsd?: number;
  sessionId?: string;
};

export type ClaudeOptions = Pick<Required<BotConfig>, "model" | "maxTurns" | "systemPrompt" | "cwd" | "permissionMode"> & {
  sessionId?: string;
  /** User ID for memory persistence */
  userId?: string;
};

/** Path to claude.js executable */
const CLAUDE_CLI_PATH = path.resolve(
  import.meta.dirname ?? __dirname,
  "..", "..", "..", "claude-code-combined", "cli.js",
);

/** Commands that clear memory */
const MEMORY_CLEAR_COMMANDS = new Set(["忘记我", "清除记忆", "forget me", "/forget"]);

/**
 * Send a prompt to Claude Code via direct subprocess (plain text mode).
 * Integrates long-term memory per user.
 * This avoids the SDK protocol layer which can cause 'input_tokens' errors
 * with proxy APIs that return non-standard streaming responses.
 */
export async function askClaude(prompt: string, opts: ClaudeOptions): Promise<ClaudeResponse> {
  const start = Date.now();

  // ── Long-term memory ──────────────────────────────────────────────
  let userId = opts.userId;

  // Handle memory clear commands
  if (userId && MEMORY_CLEAR_COMMANDS.has(prompt.trim().toLowerCase())) {
    clearMemory(userId);
    return {
      text: "已清除关于你的所有记忆。下次对话我将重新了解你。",
      durationMs: 0,
    };
  }

  // Build an augmented prompt with memory context prepended.
  // We prepend to the USER MESSAGE (not CLI args) to avoid Windows shell
  // quoting issues with newlines in --append-system-prompt.
  let augmentedPrompt = prompt;
  if (userId) {
    const existingMemory = loadMemory(userId);
    const parts = buildMemoryPromptParts(existingMemory);
    if (parts.memoryPrompt) {
      augmentedPrompt = parts.memoryPrompt.trim() + "\n\n" + prompt;
    }
    // Memory update instruction goes into system prompt (via CLI arg).
    // Since it's short and has no newlines, it won't break shell parsing.
    // Actually we'll retrofit it into the prompt too:
    if (parts.updateInstruction && !parts.memoryPrompt) {
      // No existing memory, but still tell Claude about memory updates
      augmentedPrompt = prompt + "\n\n" + parts.updateInstruction;
    } else if (parts.updateInstruction) {
      augmentedPrompt = augmentedPrompt + "\n\n" + parts.updateInstruction;
    }
  }

  // Build CLI arguments (only flags that cli.js --help confirms)
  const args: string[] = [
    CLAUDE_CLI_PATH,
    "-p",                       // Print response and exit (non-interactive mode)
    "--model", opts.model,
    "--max-turns", String(opts.maxTurns),
    "--permission-mode", opts.permissionMode,
    "--no-session-persistence",
  ];

  // Pass user's original system prompt (short, no newlines expected)
  if (opts.systemPrompt) {
    args.push("--append-system-prompt", opts.systemPrompt);
  }
  if (opts.sessionId) {
    args.push("--resume", opts.sessionId);
  }

  return new Promise((resolve, reject) => {
    const child = spawn("node", args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // 确保代理环境变量被传递
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        CLAUDE_CODE_GIT_BASH_PATH: "D:\\Program Files\\Git\\bin\\bash.exe",
        CLAUDE_CODE_SIMPLE: "1",
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        // 禁用沙箱（你的代理环境无需沙箱）
        CLAUDE_CODE_DISABLE_SANDBOX: "1",
      },
      // Windows 下需要 shell: true 来支持 git-bash
      shell: process.platform === "win32",
    });

    const texts: string[] = [];
    let stderrBuffer = "";
    let sessionId: string | undefined;
    // Read stdout for the response
    child.stdout?.on("data", (data: Buffer) => {
      const output = data.toString();
      // Claude Code 在普通模式下输出直接是文本
      texts.push(output);
    });

    // Capture stderr for debugging
    child.stderr?.on("data", (data: Buffer) => {
      stderrBuffer += data.toString();
    });

    // Handle process completion
    child.on("close", (code) => {
      const durationMs = Date.now() - start;
      let text = texts.join("").trim();

      if (code === 0 && text) {
        // ── Extract and save memory updates ──
        if (userId) {
          const { cleanText, newMemories } = extractMemoryUpdates(text);
          text = cleanText || text; // if cleanText is empty, use original
          if (newMemories.length > 0) {
            // Merge new memories with existing
            const existingMemory = loadMemory(userId);
            const updatedMemory = existingMemory
              ? existingMemory + "\n" + newMemories.join("\n")
              : newMemories.join("\n");
            saveMemory(userId, updatedMemory);
          }
        }

        resolve({
          text,
          durationMs,
          sessionId,
        });
      } else if (code !== 0) {
        // Reached max turns is a partial success, return what we have
        if (text && (stderrBuffer.includes("Reached max turns") || text.includes("Reached max turns"))) {
          if (userId) {
            const { cleanText } = extractMemoryUpdates(text);
            text = cleanText || text;
          }
          resolve({
            text: text + "\n\n[提示：任务未完成，已到达最大轮次限制。您可以继续追问来完成剩余步骤。]",
            durationMs,
            sessionId,
          });
          return;
        }
        // Try to extract error message from stderr
        const stderr = stderrBuffer.trim();
        const errorMsg = stderr || text || `进程退出码: ${code}`;
        reject(new Error(
          `Claude Code 处理失败 (exit code ${code})。\n` +
          `模型: ${opts.model}\n` +
          `错误: ${errorMsg.substring(0, 500)}`,
        ));
      } else {
        // code === 0 but no text output
        reject(new Error("Claude Code 没有返回文本内容"));
      }
    });

    child.on("error", (err) => {
      reject(new Error(`无法启动 Claude Code: ${err.message}`));
    });

    // Write prompt and close stdin
    child.stdin?.write(augmentedPrompt + "\n");
    child.stdin?.end();
  });
}
