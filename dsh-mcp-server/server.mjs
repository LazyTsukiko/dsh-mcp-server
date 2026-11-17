// Minimal stateless StreamableHTTP MCP server wrapping local DSH CLI.
// Zero dependencies. Tools: echo, agent_run, list_sessions.
import http from "node:http";
import { randomUUID } from "node:crypto";
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PORT = 8090;
const HOST = "127.0.0.1";
const AUTH_TOKEN = process.env.DSH_MCP_TOKEN || "change-me";
const SESSIONS_ROOT = path.join(os.homedir(), ".dsh", "sessions");
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

const TOOLS = [
  {
    name: "echo",
    description: "回显输入，验证 MCP 连通（工具属于用户工作电脑上的 DSH 桥）",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "要回显的文本" } },
      required: ["text"]
    }
  },
  {
    name: "agent_run",
    description:
      "在用户工作电脑上真实执行任务：通过本机 DeepSeek Harness (DSH, dsh headless) 运行自然语言任务，DSH 拥有完整的文件读写、bash 命令、代码执行能力。适用于：查询电脑上的文件/项目、执行代码、跑测试、分析本地数据。同步阻塞直到任务完成并返回最终答复文本。破坏性操作前应先向用户确认。",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "要执行的自然语言任务" },
        cwd: { type: "string", description: "工作目录（可选，默认 D:\\dsh\\workspace）" },
        timeout_sec: { type: "number", description: "超时秒数（可选，默认 900）" },
        session_id: { type: "string", description: "续接已有会话（可选，来自上次 agent_run 返回的 session_id）。传入后本轮对话延续该会话上下文" }
      },
      required: ["task"]
    }
  },
  {
    name: "list_sessions",
    description:
      "列出用户工作电脑上 DSH 的持久化会话（按最近活动排序），返回会话 id、所属工作目录、最近活动时间。用于回答'我电脑上有哪些会话/最近干了什么'。",
    inputSchema: { type: "object", properties: {} }
  }
];

function json(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", ...headers });
  res.end(body);
}

function runDsh(task, cwd, timeoutMs, sessionId) {
  return new Promise((resolve) => {
    const workdir = cwd && fs.existsSync(cwd) ? cwd : process.env.DSH_DEFAULT_CWD || "D:\\dsh\\workspace";
    const dshArgs = ["--profile", "headless", "--patch", process.env.DSH_HEADLESS_PATCH || "headless-patch.yml", "--json"];
    if (sessionId) dshArgs.push("--session-id", sessionId);
    dshArgs.push(task);
    const child = spawn("dsh", dshArgs, {
      cwd: workdir,
      shell: true,
      windowsHide: true,
      env: { ...process.env }
    });
    let out = "";
    let err = "";
    let parsed = { sessionId: "", finalText: "" };
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: -1, out, err: err + "\n[timeout after " + timeoutMs / 1000 + "s]" });
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        for (const line of out.split(/\r?\n/)) {
          if (!line.trim().startsWith("{")) continue;
          const ev = JSON.parse(line);
          if (ev.type === "session" && ev.sessionId) parsed.sessionId = ev.sessionId;
          if (ev.type === "final" && typeof ev.text === "string") parsed.finalText = ev.text;
        }
      } catch {}
      resolve({ code, out, err, ...parsed });
    });
  });
}

function listSessions() {
  if (!fs.existsSync(SESSIONS_ROOT)) return [];
  const results = [];
  for (const workdir of fs.readdirSync(SESSIONS_ROOT)) {
    const wdPath = path.join(SESSIONS_ROOT, workdir);
    if (!fs.statSync(wdPath).isDirectory()) continue;
    for (const entry of fs.readdirSync(wdPath)) {
      const p = path.join(wdPath, entry);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      const id = entry.replace(/^session-/, "");
      results.push({ session_id: id, workdir_encoded: workdir, last_active: st.mtime.toISOString() });
    }
  }
  results.sort((a, b) => b.last_active.localeCompare(a.last_active));
  return results.slice(0, 30);
}

async function callTool(name, args) {
  if (name === "echo") {
    return { content: [{ type: "text", text: "收到: " + (args.text ?? "") + " @ " + Date.now() }] };
  }
  if (name === "list_sessions") {
    const sessions = listSessions();
    return {
      content: [{
        type: "text",
        text: sessions.length
          ? "工作电脑上 DSH 的持久会话（最近优先，共 " + sessions.length + " 个，仅显示前 30）：\n" +
            sessions.map((s) => `- ${s.session_id.slice(0, 8)}  [${s.workdir_encoded}]  ${s.last_active}`).join("\n")
          : "工作电脑上暂无持久化会话。"
      }]
    };
  }
  if (name === "agent_run") {
    const timeoutMs = Math.min(Math.max((args.timeout_sec ?? 900) * 1000, 5000), 30 * 60 * 1000);
    const sessionId = args.session_id
      ? "session-" + String(args.session_id).replace(/^session-/, "")
      : "";
    const r = await runDsh(args.task, args.cwd, timeoutMs, sessionId);
    const text =
      (r.finalText && r.finalText.trim() ? r.finalText.trim() : r.out && r.out.trim() ? r.out.trim() : "[无输出]") +
      (r.err && r.err.trim() ? "\n[stderr] " + r.err.trim().slice(0, 2000) : "") +
      (r.code !== 0 ? `\n[exit code: ${r.code}]` : "") +
      (r.sessionId ? `\n[session_id: ${r.sessionId}] （要在本次会话基础上继续对话，把该值传入 session_id 参数）` : "");
    return {
      content: [{ type: "text", text }],
      isError: r.code !== 0
    };
  }
  return { content: [{ type: "text", text: "unknown tool: " + name }], isError: true };
}

const server = http.createServer(async (req, res) => {
  if (req.headers["authorization"] !== `Bearer ${AUTH_TOKEN}`) {
    return json(res, 401, { error: "Unauthorized" });
  }
  if (req.method !== "POST" || !req.url || !req.url.startsWith("/mcp")) {
    return json(res, 405, { error: "Method not allowed" });
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    let msg;
    try { msg = JSON.parse(body); } catch {
      return json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    const { id, method, params } = msg;
    const reply = (result) => json(res, 200, { jsonrpc: "2.0", id, result });
    if (method === "initialize") {
      return json(res, 200, {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "dsh-workpc", version: "1.0.0" },
          instructions:
            "这些工具连接用户工作电脑上真实运行的 DeepSeek Harness (DSH)。agent_run 会在工作电脑上真实执行任务（文件、命令、代码），返回 DSH 的最终答复。"
        }
      }, { "Mcp-Session-Id": randomUUID() });
    }
    if (method === "notifications/initialized" || method?.startsWith("notifications/")) {
      return json(res, 202, {});
    }
    if (method === "tools/list") {
      return reply({ tools: TOOLS });
    }
    if (method === "tools/call") {
      try {
        const result = await callTool(params?.name, params?.arguments ?? {});
        return reply(result);
      } catch (e) {
        return reply({ content: [{ type: "text", text: "[error] " + String(e) }], isError: true });
      }
    }
    if (method === "ping") {
      return reply({});
    }
    return json(res, 200, { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[dsh-workpc-mcp] listening on http://${HOST}:${PORT}/mcp`);
});
