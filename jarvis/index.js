/**
 * Jarvis Bot v3.0 — DeepSeek AI agent with full Friday-level capabilities
 * Tools: read/write/edit/list/run/delete/search/fetch + sub-agents + memory search
 * Features: bootstrap, cost tracking, schedules, settings, ENV management,
 *           text batching, StatusMessage, transcript log, Google Docs prefetch
 */

import { Bot, InlineKeyboard, Keyboard, InputFile } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import OpenAI from "openai";
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync,
  readdirSync, renameSync, copyFileSync, statSync, rmSync, appendFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { execSync } from "node:child_process";
import https from "node:https";
import http from "node:http";

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.BOT_TOKEN;
const AGENT_HOME = process.env.AGENT_HOME || "/home/agent";
const WORKSPACE = join(AGENT_HOME, "workspace");
const PROJECTS = join(AGENT_HOME, "projects");
const AGENT_DIR = join(AGENT_HOME, ".agent");
const DATA_DIR = join(AGENT_DIR, "jarvis");           // Jarvis-specific data
const BOT_DIR = join(AGENT_DIR, "jarvis-bot");        // Bot files + .env
const ENV_FILE = join(BOT_DIR, ".env");
const STATE_FILE = join(DATA_DIR, "state.json");
const SESSIONS_FILE = join(DATA_DIR, "sessions.json");
const OWNER_FILE = join(DATA_DIR, "owner.json");
const CRASH_FILE = join(DATA_DIR, ".crash_context.md");
const SCHEDULES_FILE = join(DATA_DIR, "schedules.json");
const TRACES_DIR = join(DATA_DIR, "traces");
const TRANSCRIPTS_DIR = join(WORKSPACE, "transcripts");
const MEDIA_DIR = join(WORKSPACE, ".media");
const SKILLS_DIR = join(AGENT_HOME, ".claude", "skills");

const MAX_HISTORY_MESSAGES = 40;
const MAX_SYSTEM_PROMPT_CHARS = 30000;
const MAX_MEMORY_CHARS = 15000;
const MAX_DIARY_CHARS = 2000;
const STREAM_THROTTLE_MS = 500;

if (!BOT_TOKEN) { console.error("BOT_TOKEN is required"); process.exit(1); }

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
if (!DEEPSEEK_API_KEY) { console.error("DEEPSEEK_API_KEY is required"); process.exit(1); }

const deepseek = new OpenAI({ apiKey: DEEPSEEK_API_KEY, baseURL: "https://api.deepseek.com" });

for (const dir of [DATA_DIR, TRACES_DIR, TRANSCRIPTS_DIR, MEDIA_DIR,
  join(WORKSPACE, "memory"), join(WORKSPACE, "knowledge"), PROJECTS]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ─── STATE ───────────────────────────────────────────────────────────────────

const DEFAULT_STATE = {
  model: "deepseek-v4-flash",
  timezone: "Europe/Moscow",
  dailySpendLimit: 5,
  costHistory: {},
  bootstrapComplete: false,
  chatId: null,
  featureFlags: { semanticSearch: false },
};

function loadState() {
  try { return { ...DEFAULT_STATE, ...JSON.parse(readFileSync(STATE_FILE, "utf8")) }; }
  catch { return { ...DEFAULT_STATE }; }
}
function saveState() { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
let state = loadState();

// ─── COST TRACKING ───────────────────────────────────────────────────────────

// deepseek-v4-flash: $0.14/1M input, $0.28/1M output
// deepseek-v4-pro:   $0.435/1M input, $0.87/1M output (скидка 75% до 31.05.2026, потом $1.74/$3.48)
const MODEL_PRICING = {
  "deepseek-v4-flash": { input: 0.000000140, output: 0.000000280 },
  "deepseek-v4-pro":   { input: 0.000000435, output: 0.000000870 },
  "deepseek-chat":     { input: 0.000000140, output: 0.000000280 }, // алиас → v4-flash
  "deepseek-reasoner": { input: 0.000000435, output: 0.000000870 }, // алиас → v4-pro
};

function calcCost(model, inputTokens, outputTokens) {
  const p = MODEL_PRICING[model] || MODEL_PRICING["deepseek-v4-flash"];
  return inputTokens * p.input + outputTokens * p.output;
}

function getTodayStr() { return new Date().toISOString().slice(0, 10); }

function recordCost(cost) {
  if (!cost || cost <= 0) return;
  const d = getTodayStr();
  if (!state.costHistory) state.costHistory = {};
  state.costHistory[d] = (state.costHistory[d] || 0) + cost;
  // Keep only last 30 days
  const keys = Object.keys(state.costHistory).sort();
  if (keys.length > 30) { delete state.costHistory[keys[0]]; }
  saveState();
}

function getTodaySpend() { return (state.costHistory && state.costHistory[getTodayStr()]) || 0; }

function checkSpendLimit() {
  const limit = state.dailySpendLimit || 5;
  const spent = getTodaySpend();
  if (spent >= limit) return "blocked";
  if (spent >= limit * 0.8) return "warning";
  return "ok";
}

function formatCost(usd) {
  if (usd < 0.001) return `$${(usd * 1000).toFixed(3)}m`;
  return `$${usd.toFixed(4)}`;
}

// ─── OWNER ───────────────────────────────────────────────────────────────────

let _ownerId = process.env.OWNER_ID || null;

function loadOwner() {
  if (_ownerId) return;
  try { _ownerId = String(JSON.parse(readFileSync(OWNER_FILE, "utf8")).id); } catch {}
}
function saveOwner(ctx) {
  const data = { id: String(ctx.from.id), name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" "), username: ctx.from.username || null, at: new Date().toISOString() };
  _ownerId = data.id;
  writeFileSync(OWNER_FILE, JSON.stringify(data, null, 2));
}
loadOwner();
function isOwner(ctx) { return _ownerId && String(ctx.from?.id) === String(_ownerId); }

// ─── KEYBOARD ────────────────────────────────────────────────────────────────

const mainKeyboard = new Keyboard()
  .text("📋 Статус").text("🔄 Новый диалог").row()
  .text("📁 Проекты").text("🧠 Память").row()
  .resized().persistent();

// ─── SESSIONS ────────────────────────────────────────────────────────────────

function loadSessions() {
  try {
    const raw = JSON.parse(readFileSync(SESSIONS_FILE, "utf8"));
    const map = new Map();
    for (const [k, v] of Object.entries(raw)) { if (Array.isArray(v)) map.set(k, v); }
    return map;
  } catch { return new Map(); }
}
function saveSessions() {
  try { writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions), null, 2)); } catch {}
}
const sessions = loadSessions();

// ─── CIRCUIT BREAKER ─────────────────────────────────────────────────────────

let _rateLimitUntil = 0;
function setGlobalRateLimit(s) { _rateLimitUntil = Date.now() + (s || 5) * 1000; }
function isGloballyRateLimited() { return Date.now() < _rateLimitUntil; }

// ─── PENDING INPUT (for settings) ────────────────────────────────────────────

const pendingInput = new Map(); // userId → { field, prompt }

async function handlePendingInput(ctx) {
  const userId = String(ctx.from.id);
  const pending = pendingInput.get(userId);
  if (!pending) return false;
  pendingInput.delete(userId);
  await pending.callback(ctx.message.text);
  return true;
}

// ─── BOOTSTRAP ───────────────────────────────────────────────────────────────

const bootstrapStep = new Map();
const bootstrapData = new Map();

const BOOTSTRAP_STEPS = [
  { key: "name",    question: "Как тебя зовут? (имя или ник)" },
  { key: "sphere",  question: "Чем занимаешься? (сфера, бизнес, профессия)" },
  { key: "tasks",   question: "Какие задачи хочешь решать с помощью Jarvis?" },
  { key: "stack",   question: "Какие инструменты и технологии используешь?" },
  { key: "style",   question: "Как предпочитаешь общаться? Кратко или подробно? Формально или неформально?" },
  { key: "mission", question: "Главная цель работы с агентом (1-2 предложения)" },
];

function getBootstrapStep(userId) { return bootstrapStep.get(userId); }

async function startBootstrap(ctx) {
  const userId = String(ctx.from.id);
  bootstrapStep.set(userId, 0);
  bootstrapData.set(userId, {});
  await ctx.reply(
    "Привет! Я Jarvis — твой персональный AI-агент на DeepSeek с реальными инструментами.\n\n" +
    "Сначала заполним твою ДНК — это займёт 2 минуты. Потом смогу помнить кто ты и что важно.\n\n" +
    `Вопрос 1/${BOOTSTRAP_STEPS.length}: ${BOOTSTRAP_STEPS[0].question}`
  );
}

async function handleBootstrap(ctx, text) {
  const userId = String(ctx.from.id);
  const stepIdx = bootstrapStep.get(userId);
  if (stepIdx === undefined) return false;

  const data = bootstrapData.get(userId) || {};
  data[BOOTSTRAP_STEPS[stepIdx].key] = text;
  bootstrapData.set(userId, data);

  const next = stepIdx + 1;
  if (next < BOOTSTRAP_STEPS.length) {
    bootstrapStep.set(userId, next);
    await ctx.reply(`Вопрос ${next + 1}/${BOOTSTRAP_STEPS.length}: ${BOOTSTRAP_STEPS[next].question}`);
  } else {
    bootstrapStep.delete(userId);
    const summary =
      `<b>Проверь данные:</b>\n\n` +
      `👤 <b>Имя:</b> ${data.name}\n` +
      `🏢 <b>Сфера:</b> ${data.sphere}\n` +
      `🎯 <b>Задачи:</b> ${data.tasks}\n` +
      `🛠 <b>Стек:</b> ${data.stack}\n` +
      `💬 <b>Стиль:</b> ${data.style}\n` +
      `🚀 <b>Миссия:</b> ${data.mission}\n\nВсё верно?`;
    const kb = new InlineKeyboard().text("✔ Создаю ДНК", "bootstrap_confirm").text("✖ Заново", "bootstrap_restart");
    await ctx.reply(summary, { parse_mode: "HTML", reply_markup: kb });
  }
  return true;
}

function writeDNAFiles(data) {
  const date = getTodayStr();

  writeFileSync(join(WORKSPACE, "USER.md"),
    `# Клиент\n\nИмя: ${data.name}\nСфера: ${data.sphere}\nЗадачи: ${data.tasks}\nИнструменты: ${data.stack}\nСтиль общения: ${data.style}\n`);

  writeFileSync(join(WORKSPACE, "MEMORY.md"),
    `# Клиент\n\nИмя: ${data.name}\nСфера: ${data.sphere}\nЗадачи: ${data.tasks}\nСтек: ${data.stack}\nСтиль: ${data.style}\nМиссия: ${data.mission}\n\n# Факты\n\n(заполняется по мере общения)\n\n# Предпочтения\n\n- Стиль общения: ${data.style}\n`);

  writeFileSync(join(WORKSPACE, "MISSION.md"),
    `# Миссия\n\n${data.mission}\n\n# Контекст\n\nВладелец: ${data.name}\nСфера: ${data.sphere}\n`);

  writeFileSync(join(WORKSPACE, "GOALS.md"),
    `# Цели и задачи\n\nОбновлено: ${date}\n\n## Основные задачи\n${data.tasks}\n\n## Активные проекты\n\n(заполняется по мере работы)\n`);

  writeFileSync(join(WORKSPACE, "PROJECTS.md"),
    `# Проекты\n\nОбновлено: ${date}\n\n## Активные\n\n(заполняется по мере работы)\n\n## Архив\n\n(завершённые)\n`);

  writeFileSync(join(WORKSPACE, "PREFERENCES.md"),
    `# Предпочтения\n\n## Стиль общения\n${data.style}\n\n## Инструменты\n${data.stack}\n\n## Формат ответов\n(уточняется по мере работы)\n`);

  writeFileSync(join(WORKSPACE, "LEARNED.md"),
    `# Что я узнал\n\n(заполняется агентом — паттерны, предпочтения, инсайты)\n`);

  if (!existsSync(join(WORKSPACE, "SOUL.md"))) {
    writeFileSync(join(WORKSPACE, "SOUL.md"),
      `# Личность агента\n\nЯ — персональный AI-агент ${data.name}.\nМоя миссия: ${data.mission}\n\n## Принципы\n- Честность важнее вежливости\n- Действие важнее описания\n- Конкретика важнее полноты\n`);
  }
}

// ─── TOOL DEFINITIONS (11 tools) ─────────────────────────────────────────────

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Читает содержимое файла на сервере.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Абсолютный путь к файлу" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Создаёт или перезаписывает файл. Создаёт папки если нужно. Для создания новых файлов ВСЕГДА используй этот инструмент — не пиши теги [ФАЙЛ:].",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Абсолютный путь" },
          content: { type: "string", description: "Содержимое файла" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Точечная замена текста в файле. old_string должен быть уникален в файле.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string", description: "Уникальный фрагмент для замены" },
          new_string: { type: "string", description: "Новый текст" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "Показывает содержимое папки с размерами файлов.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Выполняет bash-команду на сервере. Для git, npm, systemctl, установки пакетов и т.д.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Bash-команда" },
          timeout: { type: "number", description: "Таймаут в секундах (по умолчанию 30)" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Удаляет файл. Защищён от удаления DNA-файлов.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Ищет текст в файлах (grep). Возвращает совпадения с путями и номерами строк.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Текст или regex для поиска" },
          path: { type: "string", description: "Папка для поиска (по умолчанию /home/agent/workspace)" },
          file_pattern: { type: "string", description: "Маска файлов: *.md, *.js и т.д." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Загружает содержимое URL. Поддерживает Google Docs и Google Sheets.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
  },
  {
    type: "function",
    function: {
      name: "delegate_to_specialist",
      description: "Делегирует подзадачу специалисту (coder/researcher/strategist). Специалист получает свой SOUL-файл и выполняет задачу независимо. Используй для сложных специализированных задач.",
      parameters: {
        type: "object",
        properties: {
          role: { type: "string", enum: ["coder", "researcher", "strategist"], description: "Роль специалиста" },
          task: { type: "string", description: "Подробное задание для специалиста" },
          context: { type: "string", description: "Дополнительный контекст: файлы, данные, ограничения" },
        },
        required: ["role", "task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_memory",
      description: "Ищет в памяти (дневники + MEMORY.md + knowledge/) по смыслу. Используй когда нужно найти информацию из прошлых разговоров или сохранённых знаний.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Запрос для поиска по памяти" },
          days: { type: "number", description: "Искать в дневниках за последние N дней (по умолчанию 30)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "append_diary",
      description: "Добавляет запись в дневник сегодняшнего дня (memory/YYYY-MM-DD.md). Используй для сохранения важных решений, фактов, итогов работы.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "Текст записи для дневника" },
        },
        required: ["content"],
      },
    },
  },
];

// ─── SAFETY ──────────────────────────────────────────────────────────────────

const PATH_WHITELIST = ["/home/agent/", "/tmp/"];
const COMMAND_BLACKLIST = [
  /rm\s+-rf\s+\//,
  /sudo\s+rm\s+-rf/,
  /dd\s+if=/,
  /mkfs/,
  />\s*\/dev\/sd/,
  /:\(\)\{.*\}/,
  /shutdown|reboot|halt/,
  /systemctl\s+(stop|disable)\s+(agent|jarvis)/,
];
const DELETE_PROTECTED = [
  "SOUL.md", "SOUL-coder.md", "SOUL-researcher.md", "SOUL-strategist.md",
  "MEMORY.md", "GOALS.md", "CLAUDE.md", "USER.md", "MISSION.md",
  ".env", ".agent/",
];

function safetyCheck(toolName, args) {
  const p = args.path || "";
  if (["read_file", "write_file", "edit_file", "list_directory", "delete_file"].includes(toolName)) {
    if (p && !PATH_WHITELIST.some(w => p.startsWith(w))) {
      return `Доступ запрещён: путь вне разрешённой зоны (${PATH_WHITELIST.join(", ")})`;
    }
  }
  if (toolName === "run_command") {
    for (const re of COMMAND_BLACKLIST) {
      if (re.test(args.command || "")) return "Команда заблокирована по соображениям безопасности";
    }
  }
  if (toolName === "delete_file") {
    for (const prot of DELETE_PROTECTED) {
      if (p.includes(prot)) return `Защищённый файл: нельзя удалить`;
    }
  }
  return null;
}

// ─── TOOL HANDLERS ───────────────────────────────────────────────────────────

const MAX_TOOL_OUTPUT = 8192;
const trunc = (s, max = MAX_TOOL_OUTPUT) => s.length <= max ? s : s.slice(0, max) + `\n...(truncated, ${s.length} chars)`;

const TOOL_HANDLERS = {
  read_file({ path }) {
    if (!existsSync(path)) return `Файл не найден: ${path}`;
    const sz = statSync(path).size;
    if (sz > 51200) return `Файл слишком большой (${Math.round(sz / 1024)}KB > 50KB). Используй search_files.`;
    return trunc(readFileSync(path, "utf8"));
  },

  write_file({ path, content }) {
    const dir = path.split("/").slice(0, -1).join("/");
    if (dir) mkdirSync(dir, { recursive: true });
    writeFileSync(path, content, "utf8");
    return `Записан: ${path} (${content.length} символов)`;
  },

  edit_file({ path, old_string, new_string }) {
    if (!existsSync(path)) return `Файл не найден: ${path}`;
    const content = readFileSync(path, "utf8");
    if (!content.includes(old_string)) return `Строка не найдена: "${old_string.slice(0, 80)}"`;
    const count = content.split(old_string).length - 1;
    if (count > 1) return `Найдено ${count} совпадений — дай более уникальный фрагмент.`;
    writeFileSync(path, content.replace(old_string, new_string), "utf8");
    return `Обновлён: ${path}`;
  },

  list_directory({ path }) {
    if (!existsSync(path)) return `Папка не найдена: ${path}`;
    const entries = readdirSync(path, { withFileTypes: true });
    const lines = entries.map(e => {
      if (e.isDirectory()) return `📁 ${e.name}/`;
      let sz = ""; try { sz = ` (${Math.round(statSync(join(path, e.name)).size / 1024)}KB)`; } catch {}
      return `📄 ${e.name}${sz}`;
    });
    return `📂 ${path}\n\n${lines.join("\n") || "(пусто)"}`;
  },

  run_command({ command, timeout = 30 }) {
    try {
      const out = execSync(command, {
        timeout: timeout * 1000, encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        cwd: "/home/agent", env: { ...process.env, HOME: "/home/agent" },
      });
      return trunc(out || "(выполнено, нет вывода)");
    } catch (e) {
      const stderr = e.stderr ? `\nSTDERR: ${e.stderr.slice(0, 2000)}` : "";
      const stdout = e.stdout ? `\nSTDOUT: ${e.stdout.slice(0, 2000)}` : "";
      return `Ошибка (код ${e.status || "?"})${stderr}${stdout}`;
    }
  },

  delete_file({ path }) {
    if (!existsSync(path)) return `Не найдено: ${path}`;
    const st = statSync(path);
    if (st.isDirectory()) {
      const items = readdirSync(path);
      if (items.length > 0) return `Папка не пустая (${items.length} файлов). Сначала удали содержимое.`;
      rmSync(path);
    } else { unlinkSync(path); }
    return `Удалено: ${path}`;
  },

  search_files({ pattern, path: sp = WORKSPACE, file_pattern = "*" }) {
    try {
      const inc = file_pattern !== "*" ? `--include="${file_pattern}"` : "";
      const escaped = pattern.replace(/"/g, '\\"').replace(/'/g, "'\\''");
      const out = execSync(
        `grep -rn ${inc} -m 200 "${escaped}" "${sp}" 2>/dev/null || true`,
        { encoding: "utf8", timeout: 10000, cwd: "/home/agent" }
      );
      return trunc(out || "Совпадений не найдено");
    } catch (e) { return `Ошибка поиска: ${e.message}`; }
  },

  async web_fetch({ url }) {
    const content = await fetchUrl(url);
    if (!content) return `Не удалось загрузить: ${url}`;
    const clean = cleanHtml(content);
    return trunc(`[${url}]\n\n${clean}`);
  },

  async delegate_to_specialist({ role, task, context = "" }) {
    const soulPath = join(WORKSPACE, `SOUL-${role}.md`);
    const soulText = existsSync(soulPath) ? readFileSync(soulPath, "utf8") : "";
    const roleLabels = { coder: "программист", researcher: "исследователь", strategist: "стратег" };
    const systemPrompt = soulText
      ? `Ты опытный ${roleLabels[role] || role}.\n\n${soulText}\n\nОтвечай по делу, конкретно и полно.`
      : `Ты опытный ${roleLabels[role] || role}. Отвечай конкретно и полно.`;

    const userMessage = context ? `${task}\n\n## Контекст\n${context}` : task;

    try {
      const completion = await deepseek.chat.completions.create({
        model: state.model || "deepseek-v4-flash",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        max_tokens: 4096,
      });
      const text = completion.choices[0]?.message?.content || "(нет ответа)";
      if (completion.usage) {
        const cost = calcCost(state.model, completion.usage.prompt_tokens || 0, completion.usage.completion_tokens || 0);
        recordCost(cost);
      }
      return `[Специалист: ${role}]\n\n${text}`;
    } catch (e) {
      return `Ошибка вызова специалиста ${role}: ${e.message}`;
    }
  },

  search_memory({ query, days = 30 }) {
    const results = [];
    const memDir = join(WORKSPACE, "memory");

    // Search diary files (last N days)
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - days);
    try {
      const files = readdirSync(memDir)
        .filter(f => f.endsWith(".md") && f >= cutoff.toISOString().slice(0, 10))
        .sort().reverse().slice(0, 30);

      for (const f of files) {
        const text = readFileSync(join(memDir, f), "utf8");
        if (matchesQuery(text, query)) {
          const excerpt = extractExcerpt(text, query);
          results.push(`📅 ${f}:\n${excerpt}`);
        }
      }
    } catch {}

    // Search MEMORY.md
    try {
      const mem = readFileSync(join(WORKSPACE, "MEMORY.md"), "utf8");
      if (matchesQuery(mem, query)) {
        const excerpt = extractExcerpt(mem, query);
        results.push(`🧠 MEMORY.md:\n${excerpt}`);
      }
    } catch {}

    // Search knowledge/
    try {
      const knDir = join(WORKSPACE, "knowledge");
      if (existsSync(knDir)) {
        for (const f of readdirSync(knDir).filter(f => f.endsWith(".md"))) {
          const text = readFileSync(join(knDir, f), "utf8");
          if (matchesQuery(text, query)) {
            results.push(`📚 knowledge/${f}:\n${extractExcerpt(text, query)}`);
          }
        }
      }
    } catch {}

    if (!results.length) return "По запросу ничего не найдено.";
    return trunc(`Результаты по запросу "${query}":\n\n` + results.join("\n\n---\n\n"));
  },

  append_diary({ content }) {
    const today = getTodayStr();
    const diaryPath = join(WORKSPACE, "memory", `${today}.md`);
    const timestamp = new Date().toLocaleTimeString("ru-RU", { timeZone: state.timezone || "Europe/Moscow", hour: "2-digit", minute: "2-digit" });
    const entry = `\n## ${timestamp}\n\n${content}\n`;
    appendFileSync(diaryPath, entry);
    return `Записано в дневник ${today}`;
  },
};

function matchesQuery(text, query) {
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const lower = text.toLowerCase();
  return words.some(w => lower.includes(w));
}

function extractExcerpt(text, query, maxLen = 400) {
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const lower = text.toLowerCase();
  let bestIdx = 0;
  for (const w of words) {
    const idx = lower.indexOf(w);
    if (idx !== -1) { bestIdx = Math.max(0, idx - 100); break; }
  }
  return text.slice(bestIdx, bestIdx + maxLen).trim() + (text.length > bestIdx + maxLen ? "..." : "");
}

// ─── SKILLS ──────────────────────────────────────────────────────────────────

function loadSkills() {
  const skills = {};
  if (!existsSync(SKILLS_DIR)) return skills;
  try {
    for (const dir of readdirSync(SKILLS_DIR)) {
      if (dir.startsWith(".")) continue;
      const skillFile = join(SKILLS_DIR, dir, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      const content = readFileSync(skillFile, "utf8");
      let description = dir;
      const fmDesc = content.match(/^description:\s*["']?([^\n"']+?)["']?\s*$/m);
      if (fmDesc) description = fmDesc[1].trim();
      const triggerMatch = content.match(/Клиент просит:(.+)/);
      const triggerText = triggerMatch ? triggerMatch[1] : "";
      const whenMatch = content.match(/Когда активировать\n([\s\S]{0,500}?)(?:\n##|\n#|$)/);
      const whenText = whenMatch ? whenMatch[1] : "";
      const keywords = [...(triggerText + " " + whenText).matchAll(/"([^"]+)"/g)].map(m => m[1].toLowerCase());
      skills[dir] = { name: dir, content, description, keywords };
    }
  } catch (e) { console.error("[skills] load error:", e.message); }
  return skills;
}

const SKILLS = loadSkills();
console.log(`[skills] loaded: ${Object.keys(SKILLS).join(", ")}`);

function detectSkill(text) {
  const lower = text.toLowerCase().trim();
  for (const name of Object.keys(SKILLS)) {
    if (name === "_always") continue;
    if (lower === `/${name}` || lower.startsWith(`/${name} `) || lower.startsWith(`/${name}\n`)) return name;
  }
  for (const [name, skill] of Object.entries(SKILLS)) {
    if (name === "_always") continue;
    if (skill.keywords.length && skill.keywords.some(kw => lower.includes(kw))) return name;
  }
  return null;
}

function logToolCall(name, args, result) {
  try {
    const logFile = join(TRACES_DIR, `tools-${getTodayStr()}.log`);
    const line = `[${new Date().toISOString()}] ${name}(${JSON.stringify(args).slice(0, 200)}) -> ${String(result).slice(0, 200)}\n`;
    appendFileSync(logFile, line);
  } catch {}
}

// ─── SYSTEM PROMPT ───────────────────────────────────────────────────────────

const ARCHITECTURE_CONTEXT = `
## Кто ты и что умеешь

Ты — Jarvis v3.0, Telegram-бот на DeepSeek API.

КРИТИЧЕСКИ ВАЖНО:
- У тебя УЖЕ реализован полноценный tool-use (function calling) — 11 инструментов.
- Если тебя просят "добавить tool-use", "прикрутить инструменты" — ответь что они уже работают и перечисли список. НЕ пытайся ничего реализовывать.
- Твой исполняемый код: /home/agent/.agent/jarvis-bot/index.js — НЕ читай и НЕ изменяй его.
- /home/agent/.agent/bot/ — это ДРУГОЙ бот (Friday на Claude CLI), не трогай его вообще.

## Структура файловой системы

/home/agent/
├── workspace/          ← главная рабочая папка
│   ├── CLAUDE.md, SOUL.md, MEMORY.md, GOALS.md — ДНК-файлы
│   ├── USER.md, MISSION.md, PROJECTS.md, PREFERENCES.md, LEARNED.md
│   ├── SOUL-coder.md, SOUL-researcher.md, SOUL-strategist.md
│   ├── memory/         ← дневники по дням (YYYY-MM-DD.md)
│   ├── knowledge/      ← база знаний
│   ├── transcripts/    ← логи разговоров
│   └── .media/         ← медиафайлы от пользователя
└── projects/           ← проекты (каждый в подпапке)

## Правила работы

ВСЕГДА:
- Новые проекты создавай в /home/agent/projects/название/ (НЕ в workspace/)
- Используй write_file для создания файлов — НИКОГДА не пиши теги [ФАЙЛ:path]
- После важных решений записывай в дневник через append_diary
- Перед изменением файла читай его через read_file
- Для поиска по памяти используй search_memory

ЗАПРЕЩЕНО:
- Читать или изменять /home/agent/.agent/jarvis-bot/ (твой собственный код)
- Читать или изменять /home/agent/.agent/bot/ (Friday — другой агент)
- Изменять /etc/systemd/system/*.service
- Пытаться "добавить" или "реализовать" tool-use — он уже работает

ИНСТРУМЕНТЫ (11 штук):
- read_file, write_file, edit_file — работа с файлами
- list_directory — список файлов
- run_command — bash-команды (git, npm, systemctl и т.д.)
- delete_file — удаление (с защитой ДНК-файлов)
- search_files — grep по файлам
- web_fetch — загрузка URL (+ Google Docs/Sheets)
- delegate_to_specialist(role, task) — делегирование специалисту (coder/researcher/strategist)
- search_memory(query) — семантический поиск по памяти
- append_diary(content) — запись в дневник

СУБАГЕНТЫ: При сложных задачах делегируй через delegate_to_specialist. Например: кодинг → coder, анализ → researcher, планирование → strategist.
`;

function _safeRead(path) {
  try { return existsSync(path) ? readFileSync(path, "utf8") : ""; } catch { return ""; }
}

function buildSystemPrompt(activeSkillName = null) {
  const parts = [ARCHITECTURE_CONTEXT];

  if (SKILLS["_always"]) {
    parts.push(`--- Постоянные правила (_always) ---\n${SKILLS["_always"].content}`);
  }
  if (activeSkillName && SKILLS[activeSkillName]) {
    parts.push(`--- Активный скилл: ${activeSkillName} ---\nСледуй точно инструкциям ниже:\n\n${SKILLS[activeSkillName].content.slice(0, 6000)}`);
  }

  const dnaFiles = ["CLAUDE.md", "SOUL.md", "USER.md", "MEMORY.md", "MISSION.md", "GOALS.md", "PROJECTS.md", "PREFERENCES.md", "LEARNED.md"];
  for (const name of dnaFiles) {
    const text = _safeRead(join(WORKSPACE, name));
    if (text) {
      const trimmed = name === "MEMORY.md" && text.length > MAX_MEMORY_CHARS
        ? text.slice(0, MAX_MEMORY_CHARS) + "\n...(truncated)" : text;
      parts.push(`--- ${name} ---\n${trimmed}`);
    }
  }

  for (const soul of ["SOUL-coder.md", "SOUL-researcher.md", "SOUL-strategist.md"]) {
    const text = _safeRead(join(WORKSPACE, soul));
    if (text) parts.push(`--- ${soul} ---\n${text.slice(0, 2000)}`);
  }

  const today = getTodayStr();
  const todayDiary = _safeRead(join(WORKSPACE, "memory", `${today}.md`));
  if (todayDiary) parts.push(`--- Дневник ${today} ---\n${todayDiary.slice(-MAX_DIARY_CHARS)}`);

  const yd = new Date(); yd.setDate(yd.getDate() - 1);
  const yStr = yd.toISOString().slice(0, 10);
  const yDiary = _safeRead(join(WORKSPACE, "memory", `${yStr}.md`));
  if (yDiary) parts.push(`--- Дневник ${yStr} ---\n${yDiary.slice(-MAX_DIARY_CHARS)}`);

  if (existsSync(CRASH_FILE)) {
    try {
      parts.push(`--- Контекст: предыдущая сессия завершилась ошибкой ---\n${readFileSync(CRASH_FILE, "utf8")}`);
      unlinkSync(CRASH_FILE);
    } catch {}
  }

  parts.push(`# Текущая дата\n${today}`);
  parts.push("# Напоминание\nСохраняй важные факты через append_diary или write_file в MEMORY.md. Для поиска по прошлым разговорам используй search_memory.");

  let result = parts.join("\n\n");
  if (result.length > MAX_SYSTEM_PROMPT_CHARS) result = result.slice(0, MAX_SYSTEM_PROMPT_CHARS);
  return result;
}

// ─── STATUS MESSAGE (with elapsed timer) ─────────────────────────────────────

const THINKING_PHRASES = [
  "Думаю... ⏳", "Соображаю... 🤔", "Мозгую... 🧠",
  "Анализирую... 🔍", "Копаюсь в памяти... 📚", "Обрабатываю... ⚙️",
];
let _phraseIdx = 0;

class StatusMessage {
  constructor(ctx, messageId) {
    this.ctx = ctx;
    this.chatId = ctx.chat.id;
    this.messageId = messageId;
    this.startTime = Date.now();
    this.stopped = false;
    this.currentText = "";
    this._typingInterval = null;
    this._animInterval = null;
  }

  start() {
    this._typingInterval = setInterval(() => {
      if (!this.stopped && !isGloballyRateLimited()) {
        this.ctx.api.sendChatAction(this.chatId, "typing").catch(() => {});
      }
    }, 4000);
    this._animInterval = setInterval(() => {
      if (!this.stopped && !this.currentText && !isGloballyRateLimited()) {
        const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
        const phrase = THINKING_PHRASES[_phraseIdx++ % THINKING_PHRASES.length];
        const timer = elapsed >= 3 ? ` (${elapsed}с)` : "";
        this.ctx.api.editMessageText(this.chatId, this.messageId, phrase + timer).catch(() => {});
      }
    }, 2000);
    this.ctx.api.sendChatAction(this.chatId, "typing").catch(() => {});
  }

  async updateTool(toolName) {
    if (this.stopped) return;
    try {
      const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
      await this.ctx.api.editMessageText(this.chatId, this.messageId, `🔧 ${toolName}... (${elapsed}с)`);
    } catch {}
  }

  stop() {
    this.stopped = true;
    clearInterval(this._typingInterval);
    clearInterval(this._animInterval);
  }
}

// ─── ERROR MESSAGES ───────────────────────────────────────────────────────────

function humanizeError(msg) {
  msg = String(msg);
  if (msg.includes("429") || msg.includes("rate")) return "Слишком много запросов. Подожди минутку.";
  if (msg.includes("503") || msg.includes("overloaded")) return "Серверы DeepSeek перегружены. Попробуй через пару минут.";
  if (msg.includes("401") || msg.includes("Incorrect API")) return "Проблема с API-ключом DeepSeek. Проверь в /settings.";
  if (msg.includes("timeout") || msg.includes("ECONNRESET")) return "Таймаут. Попробуй задать вопрос короче.";
  if (msg.includes("context") || msg.includes("length")) return "Слишком длинный диалог. Нажми 🔄 Новый диалог.";
  if (msg.includes("spend limit")) return "Достигнут дневной лимит расходов. Измени лимит в /settings.";
  return null;
}

// ─── URL FETCH (with Google Docs/Sheets) ─────────────────────────────────────

const GDOCS_RE = /docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/;
const GSHEETS_RE = /docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/;

function httpGet(url, maxLen = 50000) {
  return new Promise((resolve) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { timeout: 10000, headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, maxLen).then(resolve);
      }
      if (res.statusCode !== 200) { resolve(null); res.resume(); return; }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", d => { data += d; if (data.length > maxLen) { res.destroy(); resolve(data); } });
      res.on("end", () => resolve(data));
      res.on("error", () => resolve(null));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

function cleanHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>|<\/div>|<\/h[1-6]>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchUrl(url) {
  const gdoc = url.match(GDOCS_RE);
  if (gdoc) {
    const content = await httpGet(`https://docs.google.com/document/d/${gdoc[1]}/export?format=html`);
    return content ? cleanHtml(content) : null;
  }
  const gsheet = url.match(GSHEETS_RE);
  if (gsheet) {
    return await httpGet(`https://docs.google.com/spreadsheets/d/${gsheet[1]}/export?format=csv`);
  }
  const raw = await httpGet(url);
  return raw ? cleanHtml(raw) : null;
}

async function prefetchUrls(text) {
  const urls = (text.match(/https?:\/\/[^\s<>"')\]]+/gi) || []).slice(0, 3);
  if (!urls.length) return "";
  const parts = [];
  for (const url of urls) {
    const content = await fetchUrl(url);
    if (content && content.length > 100) {
      parts.push(`[Контент: ${url}]\n${content.slice(0, 5000)}`);
    }
  }
  return parts.length ? "\n\n" + parts.join("\n\n") : "";
}

// ─── TRANSCRIPT LOG ───────────────────────────────────────────────────────────

function logTranscript(role, text) {
  try {
    const entry = JSON.stringify({ ts: new Date().toISOString(), role, text: (text || "").slice(0, 4000) }) + "\n";
    appendFileSync(join(TRANSCRIPTS_DIR, getTodayStr() + ".jsonl"), entry);
  } catch {}
}

// ─── DEEPSEEK API WITH TOOL LOOP ─────────────────────────────────────────────

let _queue = Promise.resolve();
let _cancelCurrent = null;

function callAI(prompt, history, opts = {}) {
  const p = _queue.then(() => _callDeepSeek(prompt, history, opts));
  _queue = p.catch(() => {});
  return p;
}

const MAX_TOOL_ITERATIONS = 20;

async function _callDeepSeek(prompt, history, { onProgress, activeSkill } = {}) {
  const spendStatus = checkSpendLimit();
  if (spendStatus === "blocked") {
    throw new Error(`spend limit: дневной лимит $${state.dailySpendLimit} достигнут (потрачено: ${formatCost(getTodaySpend())})`);
  }

  const systemPrompt = buildSystemPrompt(activeSkill);
  const trimmed = history.length > MAX_HISTORY_MESSAGES ? history.slice(-MAX_HISTORY_MESSAGES) : history;
  const newHistory = [...trimmed, { role: "user", content: prompt }];
  const messages = [{ role: "system", content: systemPrompt }, ...newHistory];

  let lastText = "";
  let totalCost = 0;
  let iteration = 0;

  let cancelled = false;
  _cancelCurrent = () => { cancelled = true; };

  try {
    while (iteration < MAX_TOOL_ITERATIONS) {
      if (cancelled) throw new Error("Отменено пользователем");
      iteration++;

      const completion = await deepseek.chat.completions.create({
        model: state.model || "deepseek-v4-flash",
        messages,
        tools: TOOLS,
        tool_choice: "auto",
        max_tokens: 8192,
      });

      if (completion.usage) {
        const cost = calcCost(state.model, completion.usage.prompt_tokens || 0, completion.usage.completion_tokens || 0);
        totalCost += cost;
      }

      const choice = completion.choices[0];
      const assistantMsg = choice.message;
      messages.push(assistantMsg);

      if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
        lastText = assistantMsg.content || "(пустой ответ)";
        break;
      }

      if (typeof onProgress === "function") {
        const names = assistantMsg.tool_calls.map(t => t.function.name).join(", ");
        await onProgress(names);
      }

      for (const toolCall of assistantMsg.tool_calls) {
        if (cancelled) break;
        const name = toolCall.function.name;
        let args = {};
        try { args = JSON.parse(toolCall.function.arguments); } catch {}

        const safetyErr = safetyCheck(name, args);
        let result;

        if (safetyErr) {
          result = `ЗАБЛОКИРОВАНО: ${safetyErr}`;
        } else {
          const handler = TOOL_HANDLERS[name];
          if (!handler) { result = `Неизвестный инструмент: ${name}`; }
          else {
            try { result = await handler(args); }
            catch (e) { result = `Ошибка ${name}: ${e.message}`; }
          }
        }

        const resultStr = String(result);
        logToolCall(name, args, resultStr);
        console.log(`[tool] ${name}(${JSON.stringify(args).slice(0, 80)}) → ${resultStr.slice(0, 80)}`);

        messages.push({ role: "tool", tool_call_id: toolCall.id, content: resultStr });
      }
    }

    if (!lastText) lastText = "⚠️ Задача слишком большая — DeepSeek исчерпал 20 итераций инструментов. Попробуй разбить задачу на части.";

    recordCost(totalCost);
    logTranscript("user", prompt);
    logTranscript("assistant", lastText);

    newHistory.push({ role: "assistant", content: lastText });
    return { text: lastText, history: newHistory, cost: totalCost };

  } catch (err) {
    try { writeFileSync(CRASH_FILE, `Запрос (${new Date().toISOString()}):\n${prompt.slice(0, 500)}\n\nОшибка: ${err.message}`); } catch {}
    throw err;
  } finally {
    _cancelCurrent = null;
  }
}

// ─── FILE DOWNLOAD ────────────────────────────────────────────────────────────

async function downloadTgFile(url, destPath) {
  const proto = url.startsWith("https") ? https : http;
  const response = await new Promise((resolve, reject) => {
    proto.get(url, res => { if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`)); resolve(res); }).on("error", reject);
  });
  await pipeline(response, createWriteStream(destPath));
}

async function downloadAndSave(ctx, fileId, ext) {
  const file = await ctx.api.getFile(fileId);
  const tmpPath = `/tmp/media_${Date.now()}_${fileId.slice(-8)}${ext}`;
  await downloadTgFile(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`, tmpPath);
  const destPath = join(MEDIA_DIR, `${Date.now()}_${fileId.slice(-8)}${ext}`);
  try { renameSync(tmpPath, destPath); } catch { copyFileSync(tmpPath, destPath); unlinkSync(tmpPath); }
  return destPath;
}

// ─── MEDIA BATCH ─────────────────────────────────────────────────────────────

const MEDIA_BATCH_DELAY = 2500;
const mediaBatch = new Map();

async function enqueueMedia(ctx, item) {
  if (!isOwner(ctx)) return;
  const key = String(ctx.chat.id);
  let batch = mediaBatch.get(key);
  if (batch) {
    batch.items.push(item);
    if (item.caption && !batch.caption) batch.caption = item.caption;
    batch.ctx = ctx;
    clearTimeout(batch.timer);
    batch.timer = setTimeout(() => processMediaBatch(key), MEDIA_BATCH_DELAY);
    try { await ctx.api.editMessageText(ctx.chat.id, batch.statusMsgId, `Принимаю файлы... (${batch.items.length} шт) ⏳`); } catch {}
    return;
  }
  const statusMsg = await ctx.reply("Принимаю файл... ⏳");
  batch = { items: [item], caption: item.caption || null, chatId: ctx.chat.id, userId: String(ctx.from.id), statusMsgId: statusMsg.message_id, ctx, timer: null };
  batch.timer = setTimeout(() => processMediaBatch(key), MEDIA_BATCH_DELAY);
  mediaBatch.set(key, batch);
}

async function processMediaBatch(key) {
  const batch = mediaBatch.get(key);
  if (!batch) return;
  mediaBatch.delete(key);
  clearTimeout(batch.timer);
  const { ctx, items, userId, chatId, statusMsgId } = batch;

  try { await ctx.api.editMessageText(chatId, statusMsgId, `Скачиваю ${items.length === 1 ? "файл" : items.length + " файлов"}... ⏳`); } catch {}

  const downloaded = [];
  for (const it of items) {
    try { downloaded.push({ ...it, path: await downloadAndSave(ctx, it.fileId, it.ext) }); } catch {}
  }

  if (!downloaded.length) { try { await ctx.api.editMessageText(chatId, statusMsgId, "Не удалось скачать файлы."); } catch {} return; }

  const filesBlock = downloaded.map(d => {
    const label = d.kind === "photo" ? "Фото" : d.kind === "video" ? "Видео" : `Файл (${d.fileName || d.ext})`;
    return `${label}: ${d.path}`;
  }).join("\n");
  const prompt = `Пользователь отправил медиа. Файлы сохранены:\n${filesBlock}${batch.caption ? `\n\nПодпись: ${batch.caption}` : ""}`;

  const status = new StatusMessage(ctx, statusMsgId);
  status.start();
  const typingInterval = setInterval(() => { if (!isGloballyRateLimited()) ctx.api.sendChatAction(chatId, "typing").catch(() => {}); }, 4000);

  try {
    const history = sessions.get(userId) || [];
    const result = await callAI(prompt, history, { onProgress: async (t) => status.updateTool(t) });
    sessions.set(userId, result.history);
    saveSessions();
    status.stop(); clearInterval(typingInterval);
    await ctx.api.deleteMessage(chatId, statusMsgId).catch(() => {});
    await sendResponse(ctx, result.text);
    if (result.cost > 0) console.log(`[cost] media: ${formatCost(result.cost)}`);
  } catch (err) {
    status.stop(); clearInterval(typingInterval);
    await ctx.api.deleteMessage(chatId, statusMsgId).catch(() => {});
    await ctx.reply(humanizeError(err.message) || "Ошибка обработки медиа.", { reply_markup: mainKeyboard });
  }
}

// ─── VOICE ───────────────────────────────────────────────────────────────────

async function transcribeVoice(filePath) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (apiKey) { try { return await _deepgramTranscribe(filePath, apiKey); } catch {} }
  try { return _whisperTranscribe(filePath); } catch { return null; }
}

function _deepgramTranscribe(filePath, apiKey) {
  return new Promise((resolve, reject) => {
    const fileData = readFileSync(filePath);
    const req = https.request({
      hostname: "api.deepgram.com",
      path: "/v1/listen?model=nova-2&language=ru&smart_format=true",
      method: "POST",
      headers: { Authorization: `Token ${apiKey}`, "Content-Type": "audio/ogg", "Content-Length": fileData.length },
    }, res => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => { try { resolve(JSON.parse(data).results?.channels?.[0]?.alternatives?.[0]?.transcript || ""); } catch { resolve(""); } });
    });
    req.on("error", reject);
    req.write(fileData); req.end();
  });
}

function _whisperTranscribe(filePath) {
  try { execSync("which whisper", { stdio: "ignore" }); } catch { return null; }
  try {
    execSync(`whisper "${filePath}" --model base --language ru --output_format txt --output_dir /tmp`, { timeout: 60000, stdio: "ignore" });
    const txtFile = join("/tmp", basename(filePath).replace(/\.\w+$/, ".txt"));
    if (existsSync(txtFile)) { const t = readFileSync(txtFile, "utf8").trim(); try { unlinkSync(txtFile); } catch {} return t; }
  } catch {}
  return null;
}

// ─── MARKDOWN → HTML ─────────────────────────────────────────────────────────

function escapeHtml(t) { return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function mdToTgHtml(text) {
  if (!text) return "";
  let r = text;
  r = r.replace(/```[\w]*\n([\s\S]*?)```/g, (_, c) => `<pre>${escapeHtml(c.trim())}</pre>`);
  r = r.replace(/`([^`]+)`/g, (_, c) => `<code>${escapeHtml(c)}</code>`);
  r = r.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  r = r.replace(/__(.+?)__/g, "<b>$1</b>");
  r = r.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, "<i>$1</i>");
  r = r.replace(/(?<!\w)_([^_]+)_(?!\w)/g, "<i>$1</i>");
  r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  r = r.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  return r;
}

// ─── MEDIA TAGS ──────────────────────────────────────────────────────────────

const MEDIA_TAG_RE = /\[(ФОТО|ФАЙЛ|СТИКЕР|ВИДЕО|АУДИО|ГОЛОС|GIF|PHOTO|FILE|STICKER|VIDEO|AUDIO|VOICE|ANIMATION):\s*([^\]\s]+)(?:\s+([^\]]*))?\]/gi;
const MEDIA_TYPE_MAP = {
  "ФОТО": "photo", "PHOTO": "photo", "ФАЙЛ": "document", "FILE": "document",
  "СТИКЕР": "sticker", "STICKER": "sticker", "ВИДЕО": "video", "VIDEO": "video",
  "АУДИО": "audio", "AUDIO": "audio", "ГОЛОС": "voice", "VOICE": "voice",
  "GIF": "animation", "ANIMATION": "animation",
};

function extractMediaTags(text) {
  const media = [];
  const cleaned = text.replace(MEDIA_TAG_RE, (_, type, path, caption) => {
    media.push({ type: MEDIA_TYPE_MAP[type.toUpperCase()] || "document", path: path.trim(), caption: caption?.trim()?.slice(0, 1024) });
    return "";
  });
  return { cleaned: cleaned.trim(), media };
}

async function sendMediaItem(ctx, item) {
  try {
    const isUrl = /^https?:\/\//i.test(item.path);
    let source = isUrl ? item.path : existsSync(item.path) ? new InputFile(await readFile(item.path), basename(item.path)) : null;
    if (!source) { await ctx.reply(`⚠️ Файл не найден: <code>${item.path}</code>`, { parse_mode: "HTML" }); return; }
    const opts = item.caption && item.type !== "sticker" ? { caption: item.caption } : {};
    switch (item.type) {
      case "photo": await ctx.replyWithPhoto(source, opts); break;
      case "document": await ctx.replyWithDocument(source, opts); break;
      case "voice": await ctx.replyWithVoice(source, opts); break;
      case "video": await ctx.replyWithVideo(source, opts); break;
      case "audio": await ctx.replyWithAudio(source, opts); break;
      case "animation": await ctx.replyWithAnimation(source, opts); break;
      case "sticker": await ctx.replyWithSticker(source); break;
      default: await ctx.replyWithDocument(source, opts);
    }
  } catch { await ctx.reply(`⚠️ Не удалось отправить: ${basename(item.path)}`).catch(() => {}); }
}

// ─── SEND RESPONSE ────────────────────────────────────────────────────────────

const CHUNK_HARD = 4096;
const CHUNK_SOFT = 1800;

function splitChunks(html) {
  const chunks = []; let cur = "";
  for (const para of html.split("\n\n")) {
    if (para.length > CHUNK_HARD) {
      if (cur) { chunks.push(cur); cur = ""; }
      for (const line of para.split("\n")) {
        if (cur.length + line.length + 1 > CHUNK_HARD) { if (cur) chunks.push(cur); cur = line.slice(0, CHUNK_HARD); }
        else cur = cur ? cur + "\n" + line : line;
      }
    } else if (cur.length + para.length + 2 > CHUNK_SOFT && cur) { chunks.push(cur); cur = para; }
    else cur = cur ? cur + "\n\n" + para : para;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function needsConfirmation(text) { return /делаем\s*\?|план:|✔\s*(или|\/)\s*✖/i.test(text.toLowerCase()); }
function confirmKeyboard() { return new InlineKeyboard().text("✔ Продолжай", "confirm_yes").text("✖ Стоп", "confirm_no"); }

async function sendResponse(ctx, text) {
  const { cleaned, media } = extractMediaTags(text);
  const html = mdToTgHtml(cleaned);
  const hasConfirm = needsConfirmation(cleaned);
  const markup = hasConfirm ? confirmKeyboard() : mainKeyboard;

  if (html.length <= CHUNK_HARD) {
    try { await ctx.reply(html, { parse_mode: "HTML", reply_markup: markup }); }
    catch { await ctx.reply(cleaned, { reply_markup: markup }); }
  } else {
    const chunks = splitChunks(html);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      try { await ctx.reply(chunks[i], { parse_mode: "HTML", ...(isLast ? { reply_markup: markup } : {}) }); }
      catch { await ctx.reply(chunks[i].replace(/<[^>]+>/g, ""), isLast ? { reply_markup: markup } : {}); }
    }
  }
  for (const item of media) await sendMediaItem(ctx, item);
}

// ─── ENV MANAGEMENT ───────────────────────────────────────────────────────────

function loadEnvVars() {
  if (!existsSync(ENV_FILE)) return {};
  const vars = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) vars[m[1]] = m[2];
  }
  return vars;
}

const SYSTEM_ENV_KEYS = new Set(["BOT_TOKEN", "DEEPSEEK_API_KEY", "DEEPSEEK_MODEL", "AGENT_HOME", "OWNER_ID", "NODE_OPTIONS"]);

function saveEnvVar(key, value) {
  if (SYSTEM_ENV_KEYS.has(key)) return false;
  const vars = loadEnvVars();
  vars[key] = value;
  writeFileSync(ENV_FILE, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  process.env[key] = value;
  return true;
}

function deleteEnvVar(key) {
  if (SYSTEM_ENV_KEYS.has(key)) return false;
  const vars = loadEnvVars();
  delete vars[key];
  writeFileSync(ENV_FILE, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  delete process.env[key];
  return true;
}

const ENV_SERVICES = [
  { key: "DEEPGRAM_API_KEY", label: "🎤 Deepgram (голосовые)" },
  { key: "GITHUB_TOKEN", label: "🐙 GitHub" },
  { key: "VERCEL_TOKEN", label: "▲ Vercel" },
  { key: "SUPABASE_URL", label: "🗄️ Supabase URL" },
  { key: "OPENROUTER_API_KEY", label: "🧠 OpenRouter" },
  { key: "VOYAGE_API_KEY", label: "🔍 Voyage AI (семантика)" },
];

// ─── SETTINGS MENU ────────────────────────────────────────────────────────────

function settingsKeyboard() {
  const model = state.model || "deepseek-v4-flash";
  const modelLabel = model === "deepseek-v4-pro" ? "🟣 V4 Pro (умный)" : "🔵 V4 Flash (быстрый)";
  const spent = getTodaySpend();
  const limit = state.dailySpendLimit || 5;
  return new InlineKeyboard()
    .text(`${modelLabel}`, "settings_model").row()
    .text(`🌍 Часовой пояс: ${state.timezone || "Europe/Moscow"}`, "settings_tz").row()
    .text(`💰 Лимит/день: $${limit} (потрачено: ${formatCost(spent)})`, "settings_limit").row()
    .text("🔑 API-ключи", "settings_env").row()
    .text("✖ Закрыть", "settings_close");
}

function envKeyboard() {
  const vars = loadEnvVars();
  const kb = new InlineKeyboard();
  for (const svc of ENV_SERVICES) {
    const has = !!vars[svc.key] || !!process.env[svc.key];
    kb.text(`${has ? "✅" : "➕"} ${svc.label}`, `env_set_${svc.key}`).row();
  }
  kb.text("◀ Назад", "settings_main");
  return kb;
}

// ─── STATUS / MEMORY / PROJECTS ───────────────────────────────────────────────

function getStatusText() {
  const dna = ["SOUL.md", "USER.md", "MEMORY.md", "MISSION.md", "GOALS.md", "PROJECTS.md", "PREFERENCES.md", "LEARNED.md"];
  const found = dna.filter(f => existsSync(join(WORKSPACE, f)));
  const souls = ["SOUL-coder.md", "SOUL-researcher.md", "SOUL-strategist.md"].filter(f => existsSync(join(WORKSPACE, f)));
  let projects = "пусто";
  try { const d = readdirSync(PROJECTS, { withFileTypes: true }).filter(e => e.isDirectory()); if (d.length) projects = d.map(e => e.name).join(", "); } catch {}
  let mediaCount = 0; try { mediaCount = readdirSync(MEDIA_DIR).length; } catch {}
  const today = getTodayStr();
  const spent = getTodaySpend();
  const limit = state.dailySpendLimit || 5;
  return `📋 Jarvis v3.0\n\n` +
    `Модель: ${state.model || "deepseek-v4-flash"}\n` +
    `Инструменты: ${TOOLS.length} (read/write/edit/list/run/del/search/fetch/delegate/memory/diary)\n` +
    `Субагенты: coder, researcher, strategist\n` +
    `DNA-файлы: ${found.length}/${dna.length}\n` +
    `SOUL-режимы: ${souls.length > 0 ? souls.map(s => s.replace("SOUL-", "").replace(".md", "")).join(", ") : "только базовый"}\n` +
    `Таймзона: ${state.timezone || "Europe/Moscow"}\n` +
    `Bootstrap: ${state.bootstrapComplete ? "✅" : "не завершён"}\n` +
    `Дневник сегодня: ${existsSync(join(WORKSPACE, "memory", `${today}.md`)) ? "есть" : "нет"}\n` +
    `Расходы сегодня: ${formatCost(spent)} / $${limit}\n` +
    `Медиафайлов: ${mediaCount}\n` +
    `Проекты: ${projects}`;
}

function getLogText() {
  const memDir = join(WORKSPACE, "memory");
  const results = [];
  try {
    const files = readdirSync(memDir).filter(f => f.endsWith(".md")).sort().reverse().slice(0, 3);
    for (const f of files) {
      const content = readFileSync(join(memDir, f), "utf8").slice(0, 800);
      results.push(`📅 ${f}:\n${content}`);
    }
  } catch {}
  return results.length ? `📋 Последние дневники:\n\n${results.join("\n\n---\n\n")}` : "Дневник пуст.";
}

function getProjectsText() {
  let dirs = []; try { dirs = readdirSync(PROJECTS, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch {}
  return dirs.length
    ? `📁 Проекты (${dirs.length})\n\n` + dirs.map(d => `- ${d}`).join("\n") + `\n\nПуть: ${PROJECTS}`
    : `📁 Проекты\n\nПока пусто.\nПуть: ${PROJECTS}`;
}

function getMemoryText() {
  const memDir = join(WORKSPACE, "memory");
  let files = []; try { files = readdirSync(memDir).filter(f => f.endsWith(".md")).sort().reverse().slice(0, 7); } catch {}
  let lines = 0; try { lines = readFileSync(join(WORKSPACE, "MEMORY.md"), "utf8").split("\n").length; } catch {}
  return `🧠 Память\n\nMEMORY.md: ${lines} строк\n\nПоследние дневники:\n` + (files.length ? files.map(f => `- ${f}`).join("\n") : "пусто");
}

// ─── TEXT BATCHING ────────────────────────────────────────────────────────────

const TEXT_BATCH_DELAY = 2000;
const textBatch = new Map(); // userId → { texts, timer, ctx }

async function enqueueText(ctx, text) {
  const userId = String(ctx.from.id);
  let batch = textBatch.get(userId);
  if (batch) {
    batch.texts.push(text);
    batch.ctx = ctx;
    clearTimeout(batch.timer);
    batch.timer = setTimeout(() => processTextBatch(userId), TEXT_BATCH_DELAY);
    return;
  }
  batch = { texts: [text], ctx, timer: null };
  batch.timer = setTimeout(() => processTextBatch(userId), TEXT_BATCH_DELAY);
  textBatch.set(userId, batch);
}

async function processTextBatch(userId) {
  const batch = textBatch.get(userId);
  if (!batch) return;
  textBatch.delete(userId);
  clearTimeout(batch.timer);
  const { ctx, texts } = batch;
  const combinedText = texts.join("\n");
  await handleTextMessage(ctx, combinedText);
}

async function handleTextMessage(ctx, text) {
  const userId = String(ctx.from.id);

  const skillName = detectSkill(text);
  let cleanText = text;
  if (skillName && (text.toLowerCase().startsWith(`/${skillName} `) || text.toLowerCase().trim() === `/${skillName}`)) {
    cleanText = text.slice(skillName.length + 1).trim() || text;
  }

  const thinkingMsg = await ctx.reply(
    skillName
      ? `${THINKING_PHRASES[_phraseIdx++ % THINKING_PHRASES.length].replace("...", "")} [${skillName}]...`
      : THINKING_PHRASES[_phraseIdx++ % THINKING_PHRASES.length]
  );
  const status = new StatusMessage(ctx, thinkingMsg.message_id);
  status.start();

  try {
    const urlContext = await prefetchUrls(cleanText);
    const enrichedPrompt = urlContext ? cleanText + urlContext : cleanText;
    const history = sessions.get(userId) || [];
    const result = await callAI(enrichedPrompt, history, {
      onProgress: async (toolName) => status.updateTool(toolName),
      activeSkill: skillName,
    });

    sessions.set(userId, result.history);
    saveSessions();

    status.stop();
    await ctx.api.deleteMessage(ctx.chat.id, thinkingMsg.message_id).catch(() => {});
    await sendResponse(ctx, result.text);

    if (result.cost > 0) {
      const spendStatus = checkSpendLimit();
      if (spendStatus === "warning") {
        const spent = getTodaySpend();
        await ctx.reply(`⚠️ Использовано ${formatCost(spent)} из $${state.dailySpendLimit} дневного лимита (80%).`, { reply_markup: mainKeyboard });
      }
      console.log(`[cost] ${formatCost(result.cost)} | total today: ${formatCost(getTodaySpend())}`);
    }
  } catch (err) {
    status.stop();
    await ctx.api.deleteMessage(ctx.chat.id, thinkingMsg.message_id).catch(() => {});
    const match = err.message.match(/retry.after.*?(\d+)/i);
    if (match) setGlobalRateLimit(parseInt(match[1]));
    await ctx.reply(humanizeError(err.message) || "Произошла ошибка. Попробуй снова.", { reply_markup: mainKeyboard });
  }
}

// ─── TELEGRAM BOT ─────────────────────────────────────────────────────────────

const bot = new Bot(BOT_TOKEN);
bot.api.config.use(autoRetry());

// ─── COMMANDS ─────────────────────────────────────────────────────────────────

bot.command("start", async ctx => {
  if (!_ownerId) {
    saveOwner(ctx);
    state.chatId = String(ctx.chat.id);
    saveState();
  }
  if (!isOwner(ctx)) return;
  if (!state.chatId) { state.chatId = String(ctx.chat.id); saveState(); }

  if (!state.bootstrapComplete) {
    await startBootstrap(ctx);
    return;
  }
  await ctx.reply("Привет! Чем могу помочь?", { reply_markup: mainKeyboard });
});

bot.command("reset", async ctx => {
  if (!isOwner(ctx)) return;
  sessions.delete(String(ctx.from.id));
  saveSessions();
  await ctx.reply("Сессия сброшена.", { reply_markup: mainKeyboard });
});

bot.command("status", async ctx => {
  if (!isOwner(ctx)) return;
  await ctx.reply(getStatusText(), { reply_markup: mainKeyboard });
});

bot.command("log", async ctx => {
  if (!isOwner(ctx)) return;
  await ctx.reply(getLogText(), { reply_markup: mainKeyboard });
});

bot.command("skills", async ctx => {
  if (!isOwner(ctx)) return;
  const entries = Object.entries(SKILLS).filter(([n]) => n !== "_always");
  if (!entries.length) return ctx.reply("Скиллы не найдены в .claude/skills/");
  const lines = entries.map(([name, s]) => {
    const kws = s.keywords.slice(0, 3).map(k => `"${k}"`).join(", ");
    return `• <code>/${name}</code> — ${s.description}${kws ? `\n  <i>автодетект: ${kws}</i>` : ""}`;
  });
  await ctx.reply(
    `📚 <b>Скиллы (${entries.length}):</b>\n\n${lines.join("\n\n")}\n\nИспользуй <code>/skill-name текст</code> или напиши запрос — скилл активируется автоматически.`,
    { parse_mode: "HTML", reply_markup: mainKeyboard }
  );
});

bot.command("stop", async ctx => {
  if (!isOwner(ctx)) return;
  if (_cancelCurrent) {
    _cancelCurrent();
    await ctx.reply("Остановлено.", { reply_markup: mainKeyboard });
  } else {
    await ctx.reply("Нет активной задачи.", { reply_markup: mainKeyboard });
  }
});

bot.command("privacy", async ctx => {
  if (!isOwner(ctx)) return;
  const paths = [join(WORKSPACE, "DATA-POLICY.md"), join(AGENT_DIR, "DATA-POLICY.md")];
  const p = paths.find(existsSync);
  if (p) {
    let content = readFileSync(p, "utf8");
    if (content.length > 4000) content = content.slice(0, 4000) + "\n\n…(обрезано)";
    await ctx.reply(content);
  } else {
    await ctx.reply("Политика данных не настроена. Используй /settings для настройки.");
  }
});

bot.command("settings", async ctx => {
  if (!isOwner(ctx)) return;
  await ctx.reply("⚙️ Настройки Jarvis:", { reply_markup: settingsKeyboard() });
});

// ─── KEYBOARD BUTTONS ─────────────────────────────────────────────────────────

bot.hears("📋 Статус", async ctx => { if (!isOwner(ctx)) return; await ctx.reply(getStatusText(), { reply_markup: mainKeyboard }); });
bot.hears("🔄 Новый диалог", async ctx => {
  if (!isOwner(ctx)) return;
  sessions.delete(String(ctx.from.id)); saveSessions();
  await ctx.reply("Сессия сброшена.", { reply_markup: mainKeyboard });
});
bot.hears("📁 Проекты", async ctx => { if (!isOwner(ctx)) return; await ctx.reply(getProjectsText(), { reply_markup: mainKeyboard }); });
bot.hears("🧠 Память", async ctx => { if (!isOwner(ctx)) return; await ctx.reply(getMemoryText(), { reply_markup: mainKeyboard }); });

// ─── CALLBACK QUERIES ─────────────────────────────────────────────────────────

bot.on("callback_query:data", async ctx => {
  if (!isOwner(ctx)) return ctx.answerCallbackQuery("⛔");
  const data = ctx.callbackQuery.data;
  await ctx.answerCallbackQuery();

  // Bootstrap
  if (data === "bootstrap_confirm") {
    const userId = String(ctx.from.id);
    const d = bootstrapData.get(userId);
    bootstrapData.delete(userId);
    if (d) {
      writeDNAFiles(d);
      state.bootstrapComplete = true;
      saveState();
      await ctx.editMessageText("✅ ДНК-файлы созданы! Теперь я знаю кто ты и что важно.\n\nГотов к работе.", { parse_mode: "HTML" });
      await ctx.reply("Что начнём делать?", { reply_markup: mainKeyboard });
    }
    return;
  }
  if (data === "bootstrap_restart") {
    await ctx.editMessageText("Хорошо, начнём заново.");
    await startBootstrap(ctx);
    return;
  }

  // Confirm/Stop
  if (data === "confirm_yes") {
    const userId = String(ctx.from.id);
    const thinkingMsg = await ctx.reply(THINKING_PHRASES[_phraseIdx++ % THINKING_PHRASES.length]);
    const status = new StatusMessage(ctx, thinkingMsg.message_id);
    status.start();
    try {
      const history = sessions.get(userId) || [];
      const result = await callAI("✔ Продолжай выполнение.", history, { onProgress: async (t) => status.updateTool(t) });
      sessions.set(userId, result.history); saveSessions();
      status.stop();
      await ctx.api.deleteMessage(ctx.chat.id, thinkingMsg.message_id).catch(() => {});
      await sendResponse(ctx, result.text);
    } catch (err) {
      status.stop();
      await ctx.api.deleteMessage(ctx.chat.id, thinkingMsg.message_id).catch(() => {});
      await ctx.reply(humanizeError(err.message) || "Ошибка.", { reply_markup: mainKeyboard });
    }
    return;
  }
  if (data === "confirm_no") {
    await ctx.reply("Остановлено. Что дальше?", { reply_markup: mainKeyboard });
    return;
  }

  // Settings
  if (data === "settings_main") {
    await ctx.editMessageText("⚙️ Настройки Jarvis:", { reply_markup: settingsKeyboard() });
    return;
  }
  if (data === "settings_close") {
    await ctx.deleteMessage().catch(() => {});
    return;
  }
  if (data === "settings_model") {
    const current = state.model || "deepseek-v4-flash";
    const newModel = current === "deepseek-v4-pro" ? "deepseek-v4-flash" : "deepseek-v4-pro";
    state.model = newModel;
    saveState();
    const desc = newModel === "deepseek-v4-pro"
      ? "🟣 V4 Pro — умнее, для сложных задач. Цена: $0.435/1M (скидка до 31.05), потом $1.74/1M"
      : "🔵 V4 Flash — быстрее, дешевле. Цена: $0.14/1M input, $0.28/1M output";
    await ctx.editMessageText(`Модель переключена на <b>${newModel}</b>.\n\n${desc}`, { parse_mode: "HTML", reply_markup: settingsKeyboard() });
    return;
  }
  if (data === "settings_tz") {
    const tzOptions = new InlineKeyboard()
      .text("🇷🇺 Москва (UTC+3)", "tz_Europe/Moscow").row()
      .text("🇷🇺 Новосибирск (UTC+7)", "tz_Asia/Novosibirsk").row()
      .text("🇷🇺 Владивосток (UTC+10)", "tz_Asia/Vladivostok").row()
      .text("🇰🇿 Алматы (UTC+5)", "tz_Asia/Almaty").row()
      .text("◀ Назад", "settings_main");
    await ctx.editMessageText("Выбери часовой пояс:", { reply_markup: tzOptions });
    return;
  }
  if (data.startsWith("tz_")) {
    state.timezone = data.slice(3);
    saveState();
    await ctx.editMessageText(`✅ Часовой пояс: <b>${state.timezone}</b>`, { parse_mode: "HTML", reply_markup: settingsKeyboard() });
    return;
  }
  if (data === "settings_limit") {
    const limits = new InlineKeyboard()
      .text("$1/день", "limit_1").text("$3/день", "limit_3").text("$5/день", "limit_5").row()
      .text("$10/день", "limit_10").text("$20/день", "limit_20").text("$50/день", "limit_50").row()
      .text("◀ Назад", "settings_main");
    await ctx.editMessageText(`Текущий лимит: $${state.dailySpendLimit}/день\nСегодня потрачено: ${formatCost(getTodaySpend())}\n\nВыбери новый лимит:`, { reply_markup: limits });
    return;
  }
  if (data.startsWith("limit_")) {
    state.dailySpendLimit = parseInt(data.slice(6));
    saveState();
    await ctx.editMessageText(`✅ Лимит: <b>$${state.dailySpendLimit}/день</b>`, { parse_mode: "HTML", reply_markup: settingsKeyboard() });
    return;
  }
  if (data === "settings_env") {
    await ctx.editMessageText("🔑 API-ключи:", { reply_markup: envKeyboard() });
    return;
  }
  if (data.startsWith("env_set_")) {
    const key = data.slice(8);
    const svc = ENV_SERVICES.find(s => s.key === key);
    const label = svc?.label || key;
    pendingInput.set(String(ctx.from.id), {
      callback: async (value) => {
        if (saveEnvVar(key, value)) {
          await ctx.reply(`✅ ${label} сохранён.`, { reply_markup: mainKeyboard });
        }
      },
    });
    await ctx.reply(`Введи значение для <b>${label}</b>:`, { parse_mode: "HTML" });
    return;
  }
});

// ─── TEXT HANDLER ─────────────────────────────────────────────────────────────

bot.on("message:text", async ctx => {
  if (!isOwner(ctx)) return;
  if (await handlePendingInput(ctx)) return;

  const userId = String(ctx.from.id);
  const text = ctx.message.text;

  // Bootstrap
  if (await handleBootstrap(ctx, text)) return;

  // Batch rapid-fire messages
  await enqueueText(ctx, text);
});

// ─── VOICE HANDLER ────────────────────────────────────────────────────────────

bot.on("message:voice", async ctx => {
  if (!isOwner(ctx)) return;
  const thinkingMsg = await ctx.reply("Слушаю голосовое... 🎤");
  const status = new StatusMessage(ctx, thinkingMsg.message_id);
  status.start();

  try {
    const file = await ctx.getFile();
    const tmpPath = `/tmp/voice_${ctx.from.id}_${Date.now()}.ogg`;
    await downloadTgFile(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`, tmpPath);

    const transcript = await transcribeVoice(tmpPath);
    try { unlinkSync(tmpPath); } catch {}

    if (!transcript) {
      status.stop();
      await ctx.api.deleteMessage(ctx.chat.id, thinkingMsg.message_id).catch(() => {});
      if (!process.env.DEEPGRAM_API_KEY) {
        return ctx.reply("Нет ключа Deepgram для транскрипции. Добавь через /settings.", { reply_markup: mainKeyboard });
      }
      return ctx.reply("Не получилось распознать. Попробуй ещё раз или напиши текстом.", { reply_markup: mainKeyboard });
    }

    await ctx.api.editMessageText(ctx.chat.id, thinkingMsg.message_id,
      `Распознано: "${transcript.slice(0, 100)}${transcript.length > 100 ? "..." : ""}"\n\n⏳`);

    const userId = String(ctx.from.id);
    const history = sessions.get(userId) || [];
    const result = await callAI(transcript, history, { onProgress: async (t) => status.updateTool(t) });

    sessions.set(userId, result.history); saveSessions();
    status.stop();
    await ctx.api.deleteMessage(ctx.chat.id, thinkingMsg.message_id).catch(() => {});
    await sendResponse(ctx, result.text);
  } catch (err) {
    status.stop();
    await ctx.api.deleteMessage(ctx.chat.id, thinkingMsg.message_id).catch(() => {});
    await ctx.reply(humanizeError(err.message) || "Ошибка голосового.", { reply_markup: mainKeyboard });
  }
});

// ─── MEDIA HANDLERS ──────────────────────────────────────────────────────────

bot.on("message:photo", async ctx => {
  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  await enqueueMedia(ctx, { kind: "photo", fileId: photo.file_id, ext: ".jpg", caption: ctx.message.caption || null });
});
bot.on("message:document", async ctx => {
  if (!isOwner(ctx)) return;
  const doc = ctx.message.document;
  const ext = doc.file_name ? "." + doc.file_name.split(".").pop() : ".bin";
  await enqueueMedia(ctx, { kind: "document", fileId: doc.file_id, ext, fileName: doc.file_name, caption: ctx.message.caption || null });
});
bot.on("message:video", async ctx => {
  if (!isOwner(ctx)) return;
  await enqueueMedia(ctx, { kind: "video", fileId: ctx.message.video.file_id, ext: ".mp4", caption: ctx.message.caption || null });
});

// ─── SCHEDULES (timezone-aware, from JSON) ────────────────────────────────────

function getDefaultSchedules() {
  return [
    { id: "morning", name: "Утренний брифинг", type: "daily", hour: 9, minute: 0, enabled: true, lastRun: null, prompt: "Доброе утро! Составь краткий утренний брифинг: что запланировано на сегодня (из GOALS.md и дневников), что важно не забыть, какие задачи приоритетны. Будь кратким и конкретным." },
    { id: "weekly", name: "Еженедельный обзор", type: "weekly", weekdays: [7], hour: 20, minute: 0, enabled: true, lastRun: null, prompt: "Сделай краткий еженедельный обзор: посмотри дневники за последние 7 дней через search_memory, что было сделано, что не успели, что важно на следующей неделе." },
  ];
}

function loadSchedules() {
  try { return JSON.parse(readFileSync(SCHEDULES_FILE, "utf8")); }
  catch {
    const defaults = getDefaultSchedules();
    writeFileSync(SCHEDULES_FILE, JSON.stringify(defaults, null, 2));
    return defaults;
  }
}

function saveSchedules(schedules) { writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2)); }

function getNow() {
  const tz = state.timezone || "Europe/Moscow";
  const now = new Date();
  const str = now.toLocaleString("en-US", { timeZone: tz });
  const local = new Date(str);
  const weekday = local.getDay() === 0 ? 7 : local.getDay();
  return {
    hour: local.getHours(),
    minute: local.getMinutes(),
    weekday,
    dateStr: local.toISOString().slice(0, 10),
    isoNow: now.toISOString(),
  };
}

function shouldRun(sched, now) {
  if (!sched.enabled) return false;
  const lastRun = sched.lastRun ? sched.lastRun.slice(0, 10) : null;
  if (sched.type === "daily") {
    if (lastRun === now.dateStr) return false;
    return now.hour === sched.hour && now.minute >= (sched.minute || 0) && now.minute < (sched.minute || 0) + 5;
  }
  if (sched.type === "weekly") {
    if (!((sched.weekdays || [1]).includes(now.weekday))) return false;
    if (lastRun === now.dateStr) return false;
    return now.hour === sched.hour && now.minute >= (sched.minute || 0) && now.minute < (sched.minute || 0) + 5;
  }
  return false;
}

let schedulerRunning = false;

async function checkSchedules() {
  if (schedulerRunning || !state.chatId) return;
  schedulerRunning = true;
  try {
    const schedules = loadSchedules();
    const now = getNow();
    let updated = false;
    for (const sched of schedules) {
      if (!shouldRun(sched, now)) continue;
      console.log(`[scheduler] Running: ${sched.name}`);
      try {
        const history = sessions.get(_ownerId) || [];
        const result = await callAI(sched.prompt, history);
        sessions.set(_ownerId, result.history); saveSessions();
        const html = mdToTgHtml(result.text);
        const chunks = html.length > 4000 ? splitChunks(html) : [html];
        for (const chunk of chunks) {
          try { await bot.api.sendMessage(state.chatId, chunk, { parse_mode: "HTML" }); }
          catch { await bot.api.sendMessage(state.chatId, chunk.replace(/<[^>]+>/g, "")); }
        }
        if (result.cost) recordCost(result.cost);
      } catch (e) {
        console.error(`[scheduler] Error ${sched.name}:`, e.message);
        try { await bot.api.sendMessage(state.chatId, `⚠️ Ошибка расписания "${sched.name}": ${e.message}`); } catch {}
      }
      sched.lastRun = now.isoNow;
      updated = true;
    }
    if (updated) saveSchedules(schedules);
  } catch (e) { console.error("[scheduler]", e.message); }
  finally { schedulerRunning = false; }
}

setInterval(checkSchedules, 60000);
setTimeout(checkSchedules, 15000);

// ─── ERROR HANDLER & START ────────────────────────────────────────────────────

bot.catch(err => {
  console.error("[bot-error]", err.message);
  const m = String(err.message).match(/retry.after.*?(\d+)/i);
  if (m) setGlobalRateLimit(parseInt(m[1]));
});

bot.start({
  onStart: async () => {
    await bot.api.setMyCommands([
      { command: "start", description: "Меню / Онбординг" },
      { command: "reset", description: "Новая сессия" },
      { command: "status", description: "Статус системы" },
      { command: "log", description: "Последние записи дневника" },
      { command: "stop", description: "Остановить текущую задачу" },
      { command: "settings", description: "Настройки (модель, лимит, ключи)" },
      { command: "privacy", description: "Политика данных" },
    ]);
    console.log(`Jarvis v3.0 | model: ${state.model} | tools: ${TOOLS.length} | tz: ${state.timezone} | workspace: ${WORKSPACE}`);
    if (_ownerId) console.log(`Owner: ${_ownerId} | bootstrap: ${state.bootstrapComplete}`);
    else console.log("No owner yet — first /start will auto-lock");
  },
  drop_pending_updates: true,
});
