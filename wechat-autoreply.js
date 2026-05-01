import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

var SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// ── Portable configuration ─────────────────────────────────
// Priority: environment variable → config.json → fallback default

var CFG_PATH = os.homedir() + "/.weixin-claude-bot/config.json";
var cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CFG_PATH, "utf-8")); } catch(e) {}

var CLI = process.env.CLAUDE_CODE_CLI || cfg.cli || path.join(SCRIPT_DIR, "..", "claude-code-combined", "cli.js");
var CWD = process.env.CLAUDE_CODE_CWD || cfg.cwd || process.cwd();
var MEMORIES_DIR = os.homedir() + "/.weixin-claude-bot/memories";

var BS = String.fromCharCode(92); // backslash (defined early for TESSERACT path below)
var NL = String.fromCharCode(10); // newline

// ── Memory system (per-user long-term memory) ──────────────────────

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

function hashUserId(uid) {
  return crypto.createHash("sha256").update(uid).digest("hex").substring(0, 16);
}

function memoryFile(uid) { return MEMORIES_DIR + "/" + hashUserId(uid) + ".md"; }

function loadMemory(uid) {
  try { return fs.readFileSync(memoryFile(uid), "utf-8").trim(); }
  catch(e) { return ""; }
}

function saveMemory(uid, content) {
  ensureDir(MEMORIES_DIR);
  fs.writeFileSync(memoryFile(uid), content.trim() + "\n");
  console.log("  [memory] saved (" + hashUserId(uid) + ".md)");
}

/** Build memory prompt section to prepend to user message */
function buildMemoryPrompt(uid) {
  var mem = loadMemory(uid);
  if (!mem) return "";
  return "\n\n[历史记忆]\n以下是之前对话中记住的关于用户的信息，请基于这些信息回应用户：\n\n" + mem + "\n\n[记忆更新指令]\n如果你在这次对话中了解到任何关于用户的重要新信息（偏好、事实、约定等），请在回复末尾添加：\n<!-- MEMORY: 你记住的信息 -->\n例如：\n<!-- MEMORY: 用户喜欢简洁的回答 -->\n如果没有新信息需要记住，就不要输出记忆块。";
}

/** Extract MEMORY blocks from Claude's response, strip them, and save new memories */
function processMemoryResponse(text, uid) {
  var blocks = [];
  var cleanText = text.replace(/<!--\s*MEMORY:\s*([\s\S]*?)\s*-->/g, function(m, c) {
    c = c.trim();
    if (c) blocks.push(c);
    return "";
  }).trim();
  if (blocks.length > 0 && uid) {
    var existing = loadMemory(uid);
    var updated = existing ? existing + "\n" + blocks.join("\n") : blocks.join("\n");
    saveMemory(uid, updated);
  }
  return cleanText || text;
}

// ── Session helpers ────────────────────────────────────────────────

var SID_FILE = os.homedir() + "/.claude/sessions/wechat-auto.json";

function loadSid() {
  try { return JSON.parse(fs.readFileSync(SID_FILE, "utf-8")).id; }
  catch(e) { return null; }
}

function saveSid(id) {
  fs.mkdirSync(path.dirname(SID_FILE), { recursive: true });
  fs.writeFileSync(SID_FILE, JSON.stringify({ id: id }), "utf-8");
}

// ── iLink helpers (via wechat-agent) ───────────────────────────────

async function inbox() {
  try {
    var r = await fetch("http://localhost:3456/inbox");
    var d = await r.json();
    return d.messages || [];
  } catch(e) { return []; }
}

async function sendReply(to, text) {
  try {
    await fetch("http://localhost:3456/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: to, text: text })
    });
  } catch(e) {}
}

// ── Image download ───────────────────────────────────────────────────

var TEMP_DIR = os.homedir() + "/.weixin-claude-bot/temp";
ensureDir(TEMP_DIR);

async function downloadImage(url) {
  var ext = ".jpg";
  if (url.indexOf(".png") > 0) ext = ".png";
  if (url.indexOf(".gif") > 0) ext = ".gif";
  var filename = "img_" + Date.now() + "_" + crypto.randomBytes(4).toString("hex") + ext;
  var filepath = TEMP_DIR + "/" + filename;
  try {
    var resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return null;
    var buf = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(filepath, buf);
    console.log("  [image] saved: " + filename + " (" + buf.length + " bytes)");
    return filepath;
  } catch(e) {
    console.log("  [image] download failed: " + e.message);
    return null;
  }
}

// ── OCR via Tesseract ──────────────────────────────────────────────

var TESSERACT = process.env.TESSERACT_PATH || "C:" + BS + "Program Files" + BS + "Tesseract-OCR" + BS + "tesseract.exe";
var TESS_DATA = process.env.TESSDATA_PREFIX || SCRIPT_DIR + BS + "tessdata";

function ocrImage(imagePath) {
  return new Promise(function(resolve) {
    try {
      var child = spawn(TESSERACT, [imagePath, "stdout", "-l", "chi_sim+eng", "--psm", "3"], {
        env: Object.assign({}, process.env, { TESSDATA_PREFIX: TESS_DATA }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      var out = "";
      var err = "";
      child.stdout.on("data", function(d) { out += d.toString(); });
      child.stderr.on("data", function(d) { err += d.toString(); });
      child.on("close", function(code) {
        var text = out.trim();
        if (code !== 0) {
          console.log("  [ocr] tesseract error: " + err.slice(0, 100));
        }
        resolve(text || "");
      });
      child.on("error", function() { resolve(""); });
    } catch(e) {
      resolve("");
    }
  });
}

// ── Claude Code call with memory and session ───────────────────────

/** Auto-detect Git Bash path: env var → common install locations */
function findGitBash() {
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) return process.env.CLAUDE_CODE_GIT_BASH_PATH;
  var B = String.fromCharCode(92);
  var candidates = [
    "C:" + B + "Program Files" + B + "Git" + B + "bin" + B + "bash.exe",
    "C:" + B + "Program Files (x86)" + B + "Git" + B + "bin" + B + "bash.exe",
    "D:" + B + "Program Files" + B + "Git" + B + "bin" + B + "bash.exe",
    "C:" + B + "ProgramData" + B + "scoop" + B + "apps" + B + "git" + B + "current" + B + "bin" + B + "bash.exe",
  ];
  for (var p of candidates) { if (fs.existsSync(p)) return p; }
  return ""; // fallback: let Claude Code find it
}

function askClaude(userMsg, uid, sid) {
  return new Promise(function(resolve, reject) {
    // Build prompt with memory context
    var memPrompt = buildMemoryPrompt(uid);
    var fullPrompt = userMsg;
    if (memPrompt) {
      fullPrompt = memPrompt.trim() + "\n\n" + userMsg;
    }

    var args = [CLI, "-p", "--model", "deepseek-v4-flash", "--max-turns", "50", "--permission-mode", "bypassPermissions"];
    if (sid) { args.push("--session-id", sid); }

    var child = spawn("node", args, {
      cwd: CWD,
      stdio: ["pipe", "pipe", "pipe"],
      env: Object.assign({}, process.env, {
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        CLAUDE_CODE_GIT_BASH_PATH: findGitBash() || process.env.CLAUDE_CODE_GIT_BASH_PATH || "",
        CLAUDE_CODE_SIMPLE: "1",
        CLAUDE_CODE_DISABLE_SANDBOX: "1",
      }),
      shell: process.platform === "win32",
    });

    var so = "";
    var se = "";

    child.stdout.on("data", function(d) { so += d.toString(); });
    child.stderr.on("data", function(d) { se += d; });

    child.on("close", function(code) {
      var t = so.trim();

      if (code === 0 && t) {
        // Process memory updates
        t = processMemoryResponse(t, uid);
        resolve(t);
      }
      else if (t && (se.indexOf("Reached max turns") >= 0 || t.indexOf("Reached max turns") >= 0)) {
        t = processMemoryResponse(t, uid);
        resolve(t + NL + "[提示：任务未完成，已到达最大轮次限制]");
      }
      else {
        reject(new Error((se || t || "exit " + code).slice(0, 200)));
      }
    });

    child.on("error", function(e) { reject(e); });

    child.stdin.write(fullPrompt + NL);
    child.stdin.end();
  });
}

// ── Main loop ──────────────────────────────────────────────────────

async function main() {
  console.log("[autoreply] Starting...");
  var sid = loadSid();
  if (!sid) {
    sid = crypto.randomUUID();
    saveSid(sid);
  }
  console.log("[autoreply] Session: " + sid);

  // Get LAN IP for upload URL
  var LAN_IP = "localhost";
  try {
    var ifaces = os.networkInterfaces();
    for (var name in ifaces) {
      for (var addr of ifaces[name]) {
        if (addr.family === "IPv4" && !addr.internal && addr.address !== "127.0.0.1") {
          LAN_IP = addr.address;
          break;
        }
      }
      if (LAN_IP !== "localhost") break;
    }
  } catch(e) {}
  var UPLOAD_URL = "http://" + LAN_IP + ":3456/upload";
  console.log("[autoreply] Upload URL: " + UPLOAD_URL);

  var seen = new Set();
  var busy = false;
  console.log("[autoreply] Watching for WeChat messages...");

  async function poll() {
    if (busy) { setTimeout(poll, 3000); return; }
    busy = true;
    try {
      var msgs = await inbox();
      for (var i = 0; i < msgs.length; i++) {
        var msg = msgs[i];
        var key = msg.from + ":" + msg.text;
        if (seen.has(key)) { continue; }
        seen.add(key);
        if (seen.size > 1000) { seen.clear(); }

        console.log("[autoreply] >>> " + msg.text.slice(0, 100));

        try {
          // Handle image: WeChat doesn't allow direct download
          // Instead, provide upload URL for browser upload
          var prompt = msg.text;
          if (msg.imageKey) {
            console.log("  [autoreply] Image detected, upload URL: " + UPLOAD_URL);
            prompt = "📷 收到一张图片！\n\n"
              + "微信接口不支持直接下载图片，请用手机浏览器打开以下链接上传图片：\n\n"
              + UPLOAD_URL + "\n\n"
              + "上传后会自动进行OCR文字识别和分析。\n"
              + "(请确保手机和电脑在同一WiFi网络下)";
          }

          // Check for pending uploaded images (from /upload-image endpoint)
          if (!msg.imageKey && msg.text.indexOf("[pending-image:") === 0) {
            var fpath = msg.text.replace("[pending-image:", "").replace("]", "").trim();
            if (fs.existsSync(fpath)) {
              console.log("  [autoreply] Processing uploaded image: " + fpath);
              var ocrText = await ocrImage(fpath);
              if (ocrText) {
                console.log("  [ocr] extracted: " + ocrText.slice(0, 100).replace(/\n/g, " "));
                prompt = "[用户上传了一张图片]\n路径: " + fpath + "\nOCR结果:\n" + ocrText + "\n\n请回应用户的问题。";
              } else {
                console.log("  [ocr] no text found");
                prompt = "[用户上传了一张图片，未识别到文字]\n路径: " + fpath;
              }
            }
          }

          // Pass userId for memory, session ID for continuity
          var resp = await askClaude(prompt, msg.from, sid);
          console.log("[autoreply] <<< " + resp.slice(0, 100).replace(/\n/g, " "));
          await sendReply(msg.from, resp);
          console.log("[autoreply] Sent OK (sid=" + sid + ")");
        } catch (err) {
          console.error("[autoreply] Error: " + err.message);
          try { await sendReply(msg.from, "处理出错: " + err.message.slice(0, 100)); } catch(e) {}
        }
      }
    } catch(e) {}
    busy = false;
    setTimeout(poll, 3000);
  }

  setTimeout(poll, 2000);
}

main().catch(function(e) { console.error(e.message); process.exit(1); });