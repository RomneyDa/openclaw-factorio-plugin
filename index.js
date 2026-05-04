import { copyFile, mkdir, readFile, writeFile, chmod, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const here = dirname(fileURLToPath(import.meta.url));
const MOD_FILE_NAME = "openclaw-runtime_0.1.0.zip";
const MOD_ASSET = join(here, "assets", MOD_FILE_NAME);
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 27015;
const CREDENTIAL_FILE = join(homedir(), ".openclaw", "factorio-runtime-rcon.json");

const SERVERDATA_AUTH = 3;
const SERVERDATA_EXECCOMMAND = 2;

function expandHome(value) {
  if (!value) return value;
  const s = String(value);
  return s === "~" ? homedir() : s.startsWith("~/") ? join(homedir(), s.slice(2)) : s;
}

function defaultFactorioRoot() {
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "factorio");
  if (platform() === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Factorio");
  return join(homedir(), ".factorio");
}

function defaultModsDir() {
  return join(defaultFactorioRoot(), "mods");
}

function defaultConfigPath() {
  return join(defaultFactorioRoot(), "config", "config.ini");
}

function textResult(text, details) {
  return { content: [{ type: "text", text }], ...(details ? { details } : {}) };
}

function jsonResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data };
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function installMod(modsDir) {
  const targetDir = resolve(expandHome(modsDir) || defaultModsDir());
  await mkdir(targetDir, { recursive: true });
  const dest = join(targetDir, MOD_FILE_NAME);
  await copyFile(MOD_ASSET, dest);
  return dest;
}

async function loadCredentials(credentialPath = CREDENTIAL_FILE) {
  const path = resolve(expandHome(credentialPath));
  if (!(await pathExists(path))) return null;
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}

async function saveCredentials({ host, port, password, credentialPath = CREDENTIAL_FILE }) {
  const path = resolve(expandHome(credentialPath));
  await mkdir(dirname(path), { recursive: true });
  const data = { host, port, password, updatedAt: new Date().toISOString() };
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  try { await chmod(path, 0o600); } catch {}
  return path;
}

function getConfigValue(pluginConfig, key, fallback) {
  const value = pluginConfig?.[key];
  return value === undefined || value === null || value === "" ? fallback : value;
}

async function resolveRconConfig(pluginConfig = {}, overrides = {}) {
  const credentialPath = expandHome(overrides.credentialPath || pluginConfig.credentialPath || CREDENTIAL_FILE);
  const creds = await loadCredentials(credentialPath).catch(() => null);
  const host = overrides.host || process.env.FACTORIO_RCON_HOST || getConfigValue(pluginConfig, "host", creds?.host || DEFAULT_HOST);
  const port = Number(overrides.port || process.env.FACTORIO_RCON_PORT || getConfigValue(pluginConfig, "port", creds?.port || DEFAULT_PORT));
  const password = overrides.password || process.env.FACTORIO_RCON_PASSWORD || getConfigValue(pluginConfig, "password", creds?.password || "");
  return { host, port, password, credentialPath };
}

async function configureLocalRcon({ factorioConfigPath, host = DEFAULT_HOST, port = DEFAULT_PORT, password }) {
  const configPath = resolve(expandHome(factorioConfigPath) || defaultConfigPath());
  let text = "";
  if (await pathExists(configPath)) text = await readFile(configPath, "utf8");
  await mkdir(dirname(configPath), { recursive: true });

  const updates = new Map([
    ["local-rcon-socket", `${host}:${port}`],
    ["local-rcon-password", password],
  ]);
  const seen = new Set();
  const output = [];
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    const candidate = stripped.startsWith(";") ? stripped.slice(1).trim() : stripped;
    const eq = candidate.indexOf("=");
    if (eq !== -1) {
      const key = candidate.slice(0, eq).trim();
      if (updates.has(key)) {
        if (!seen.has(key)) {
          output.push(`${key}=${updates.get(key)}`);
          seen.add(key);
        }
        continue;
      }
    }
    output.push(line);
  }
  for (const [key, value] of updates) {
    if (!seen.has(key)) output.push(`${key}=${value}`);
  }

  const backup = `${configPath}.bak-openclaw-rcon`;
  if ((await pathExists(configPath)) && !(await pathExists(backup))) {
    await writeFile(backup, text);
  }
  await writeFile(configPath, `${output.join("\n").replace(/\n+$/, "")}\n`);
  return { configPath, backup: await pathExists(backup) ? backup : null };
}

async function setupFactorio({ modsDir, factorioConfigPath, host = DEFAULT_HOST, port = DEFAULT_PORT, password, credentialPath, skipMod = false, skipConfig = false } = {}) {
  const finalPassword = password || (await loadCredentials(credentialPath).catch(() => null))?.password || randomBytes(18).toString("base64url");
  const results = { host, port, credentialPath: null, modPath: null, configPath: null, backup: null, passwordConfigured: true, restartRequired: true };
  if (!skipMod) results.modPath = await installMod(modsDir);
  if (!skipConfig) {
    const configured = await configureLocalRcon({ factorioConfigPath, host, port, password: finalPassword });
    results.configPath = configured.configPath;
    results.backup = configured.backup;
  }
  results.credentialPath = await saveCredentials({ host, port, password: finalPassword, credentialPath: credentialPath || CREDENTIAL_FILE });
  return results;
}

function encodePacket(id, type, body) {
  const bodyBuf = Buffer.from(String(body ?? ""), "utf8");
  const size = 4 + 4 + bodyBuf.length + 2;
  const buf = Buffer.alloc(4 + size);
  buf.writeInt32LE(size, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBuf.copy(buf, 12);
  buf.writeInt16LE(0, 12 + bodyBuf.length);
  return buf;
}

function decodePackets(buffer) {
  const packets = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const size = buffer.readInt32LE(offset);
    if (size < 10) throw new Error(`Invalid RCON packet size: ${size}`);
    if (buffer.length - offset < 4 + size) break;
    const id = buffer.readInt32LE(offset + 4);
    const type = buffer.readInt32LE(offset + 8);
    const body = buffer.subarray(offset + 12, offset + 4 + size - 2).toString("utf8");
    packets.push({ id, type, body });
    offset += 4 + size;
  }
  return { packets, rest: buffer.subarray(offset) };
}

class RconClient {
  constructor({ host, port, password, timeoutMs = 8000 }) {
    if (!password) throw new Error("RCON password is missing. Run `openclaw factorio setup` first, or set FACTORIO_RCON_PASSWORD.");
    this.host = host;
    this.port = Number(port);
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
  }
  async connect() {
    await new Promise((resolvePromise, reject) => {
      const socket = createConnection({ host: this.host, port: this.port });
      this.socket = socket;
      const fail = (err) => reject(err);
      socket.on("data", (chunk) => this.onData(chunk));
      socket.once("error", fail);
      socket.once("connect", () => {
        socket.off("error", fail);
        resolvePromise();
      });
      socket.setTimeout(this.timeoutMs, () => reject(new Error("RCON connection timed out")));
    });
    const auth = await this.request(SERVERDATA_AUTH, this.password);
    if (auth.id === -1) throw new Error("RCON authentication failed");
  }
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const decoded = decodePackets(this.buffer);
    this.buffer = decoded.rest;
    for (const packet of decoded.packets) {
      const pending = this.pending.get(packet.id);
      if (pending) {
        this.pending.delete(packet.id);
        pending.resolve(packet);
      }
    }
  }
  request(type, body) {
    const id = this.nextId++;
    const packet = encodePacket(id, type, body);
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("RCON request timed out"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: (p) => { clearTimeout(timer); resolvePromise(p); } });
      this.socket.write(packet);
    });
  }
  async command(command) {
    const response = await this.request(SERVERDATA_EXECCOMMAND, command);
    return response.body;
  }
  close() { this.socket?.end(); }
}

function luaString(value) { return JSON.stringify(String(value ?? "")); }
function luaArg(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null || value === undefined) return "nil";
  return luaString(value);
}
function buildRemoteCall(apiName, args = []) {
  return `/c rcon.print(remote.call("openclaw", ${luaString(apiName)}${args.length ? `, ${args.map(luaArg).join(", ")}` : ""}))`;
}
function parseMaybeJson(output) {
  const trimmed = String(output || "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch {}
  }
  return trimmed;
}
async function runRconCommand(pluginConfig, command, overrides = {}) {
  const cfg = await resolveRconConfig(pluginConfig, overrides);
  const client = new RconClient(cfg);
  await client.connect();
  try { return parseMaybeJson(await client.command(command)); }
  finally { client.close(); }
}
async function callRuntime(pluginConfig, apiName, args = [], overrides = {}) {
  return runRconCommand(pluginConfig, buildRemoteCall(apiName, args), overrides);
}

const READ_ACTIONS = new Set([
  "capabilities", "players", "state", "inventory", "selected_entity", "nearby", "nearby_entities", "resources", "production", "production_stats", "force_state", "research", "technologies", "recipes", "prototypes_search", "surface_info",
]);
const SAFE_WRITE_ACTIONS = new Set(["chat"]);
const MUTATING_ACTIONS = new Set(["craft", "give_item", "remove_item", "place_entity", "destroy_selected", "mine_selected", "move", "move_player"]);

function normalizeActionParams(params = {}) {
  const action = params.action || params.api || "state";
  const player = params.player ?? "";
  switch (action) {
    case "capabilities": return { action, apiName: "capabilities", args: [] };
    case "players": return { action, apiName: "players", args: [] };
    case "state": return { action, apiName: "state", args: [player] };
    case "inventory": return { action, apiName: "inventory", args: [player] };
    case "selected_entity": return { action, apiName: "selected_entity", args: [player] };
    case "nearby_entities":
    case "nearby": return { action, apiName: "nearby_entities", args: [player, Number(params.radius ?? 10), params.name || "", params.type || "", params.force || "", Number(params.limit ?? 200)] };
    case "resources": return { action, apiName: "resources", args: [player, Number(params.radius ?? 50), Number(params.limit ?? 200)] };
    case "production_stats":
    case "production": return { action, apiName: "production_stats", args: [player] };
    case "force_state": return { action, apiName: "force_state", args: [player] };
    case "research": return { action, apiName: "research", args: [player] };
    case "technologies": return { action, apiName: "technologies", args: [player, params.query || "", Number(params.limit ?? 25)] };
    case "recipes": return { action, apiName: "recipes", args: [player, params.query || "", Number(params.limit ?? 25)] };
    case "prototypes_search": return { action, apiName: "prototypes_search", args: [params.kind || "item", params.query || "", Number(params.limit ?? 25)] };
    case "surface_info": return { action, apiName: "surface_info", args: [player] };
    case "chat": return { action, apiName: "chat", args: [params.message || ""] };
    case "place_entity": return { action, apiName: "place_entity", args: [player, params.entityName || params.entity || "", Number(params.dx ?? 0), Number(params.dy ?? 0)] };
    case "craft": return { action, apiName: "craft", args: [player, params.itemName || params.item || "", Number(params.count ?? 1)] };
    case "give_item": return { action, apiName: "give_item", args: [player, params.itemName || params.item || "", Number(params.count ?? 1)] };
    case "remove_item": return { action, apiName: "remove_item", args: [player, params.itemName || params.item || "", Number(params.count ?? 1)] };
    case "destroy_selected": return { action, apiName: "destroy_selected", args: [player] };
    case "mine_selected": return { action, apiName: "mine_selected", args: [player] };
    case "move_player":
    case "move": return { action, apiName: "move_player", args: [player, Number(params.dx ?? 0), Number(params.dy ?? 0)] };
    default: throw new Error(`Unsupported Factorio runtime action: ${action}`);
  }
}

function mutationRequiresConfirmation(pluginConfig, params) {
  if (pluginConfig.requireConfirmationForMutatingActions === false) return false;
  if (pluginConfig.allowMutationsWithoutConfirmation === true) return false;
  return !params?.confirmed;
}

const FactorioRuntimeParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["capabilities", "players", "state", "inventory", "selected_entity", "nearby", "nearby_entities", "resources", "production", "production_stats", "force_state", "research", "technologies", "recipes", "prototypes_search", "surface_info", "chat", "place_entity", "craft", "give_item", "remove_item", "destroy_selected", "mine_selected", "move", "move_player"] },
    player: { type: "string", description: "Factorio player name. Leave empty for local/single-player fallback." },
    radius: { type: "number", description: "Search radius for nearby/resource queries." },
    limit: { type: "number", description: "Maximum result count for list/search queries." },
    query: { type: "string", description: "Substring query for recipes, technologies, and prototype search." },
    kind: { type: "string", enum: ["item", "entity", "fluid", "recipe", "technology"], description: "Prototype kind for prototypes_search." },
    name: { type: "string", description: "Optional entity prototype name filter for nearby_entities." },
    type: { type: "string", description: "Optional entity type filter for nearby_entities, e.g. assembling-machine, resource, furnace." },
    force: { type: "string", description: "Optional force filter for nearby_entities, e.g. player or enemy." },
    message: { type: "string" },
    entityName: { type: "string" },
    entity: { type: "string" },
    itemName: { type: "string" },
    item: { type: "string" },
    count: { type: "number" },
    dx: { type: "number" },
    dy: { type: "number" },
    confirmed: { type: "boolean", description: "Set true only after user confirmation, unless plugin config disables mutation confirmations." }
  },
};

function registerFactorioCli(program, pluginConfig) {
  const factorio = program.command("factorio").description("Install, configure, and query the OpenClaw Factorio runtime");

  factorio.command("setup")
    .description("Install the runtime mod and configure local Factorio RCON")
    .option("--mods-dir <path>", "Override Factorio mods directory")
    .option("--config <path>", "Override Factorio config.ini path")
    .option("--host <host>", "RCON bind host", DEFAULT_HOST)
    .option("--port <port>", "RCON port", String(DEFAULT_PORT))
    .option("--password <password>", "RCON password; generated when omitted")
    .option("--credential-path <path>", "Where to store OpenClaw RCON credentials", CREDENTIAL_FILE)
    .option("--skip-mod", "Do not install the mod zip")
    .option("--skip-config", "Do not edit Factorio config.ini")
    .action(async (opts) => {
      const result = await setupFactorio({ modsDir: opts.modsDir, factorioConfigPath: opts.config, host: opts.host, port: Number(opts.port), password: opts.password, credentialPath: opts.credentialPath, skipMod: Boolean(opts.skipMod), skipConfig: Boolean(opts.skipConfig) });
      console.log(`Installed mod: ${result.modPath || "skipped"}`);
      console.log(`Configured Factorio: ${result.configPath || "skipped"}`);
      if (result.backup) console.log(`Backup: ${result.backup}`);
      console.log(`Credentials: ${result.credentialPath}`);
      console.log("Restart Factorio, enable openclaw-runtime in Mods if prompted, then load your save.");
    });

  factorio.command("status")
    .description("Show local install/config/RCON status")
    .action(async () => {
      const cfg = await resolveRconConfig(pluginConfig);
      console.log(`Mods dir: ${defaultModsDir()} exists=${existsSync(defaultModsDir()) ? "yes" : "no"}`);
      console.log(`Mod installed: ${existsSync(join(defaultModsDir(), MOD_FILE_NAME)) ? "yes" : "no"}`);
      console.log(`Factorio config: ${defaultConfigPath()} exists=${existsSync(defaultConfigPath()) ? "yes" : "no"}`);
      console.log(`Credential file: ${cfg.credentialPath} exists=${existsSync(cfg.credentialPath) ? "yes" : "no"}`);
      console.log(`RCON target: ${cfg.host}:${cfg.port} password=${cfg.password ? "configured" : "missing"}`);
      try {
        const pong = await runRconCommand(pluginConfig, `/c rcon.print("openclaw-rcon-ok")`);
        console.log(`RCON: ok (${typeof pong === "string" ? pong : JSON.stringify(pong)})`);
      } catch (error) {
        console.log(`RCON: unavailable (${error.message})`);
      }
    });

  factorio.command("raw <command...>").description("Send a raw Factorio RCON command").action(async (parts) => console.log(await runRconCommand(pluginConfig, parts.join(" "))));
  factorio.command("call <api> [args...]").description("Call remote.call('openclaw', api, ...args)").action(async (apiName, args) => console.log(JSON.stringify(await callRuntime(pluginConfig, apiName, (args || []).map((a) => /^-?\d+(\.\d+)?$/.test(a) ? Number(a) : a)), null, 2)));
  factorio.command("inventory [player]").description("Get inventory").action(async (player = "") => console.log(JSON.stringify(await callRuntime(pluginConfig, "inventory", [player]), null, 2)));
  factorio.command("state [player]").description("Get game/player state").action(async (player = "") => console.log(JSON.stringify(await callRuntime(pluginConfig, "state", [player]), null, 2)));
  factorio.command("nearby [player] [radius]").description("Get nearby entities").action(async (player = "", radius = "10") => console.log(JSON.stringify(await callRuntime(pluginConfig, "nearby_entities", [player, Number(radius)]), null, 2)));
  factorio.command("production [player]").description("Get production stats").action(async (player = "") => console.log(JSON.stringify(await callRuntime(pluginConfig, "production_stats", [player]), null, 2)));
  factorio.command("chat <message...>").description("Send an OpenClaw chat message in-game").action(async (message) => console.log(JSON.stringify(await callRuntime(pluginConfig, "chat", [message.join(" ")]), null, 2)));
}

export default definePluginEntry({
  id: "openclaw-factorio-runtime",
  name: "OpenClaw Factorio Runtime",
  description: "Installs a bundled Factorio runtime mod and exposes safe local RCON tools for live game inspection/control.",
  register(api) {
    const pluginConfig = api.config?.plugins?.entries?.["openclaw-factorio-runtime"]?.config || {};

    api.registerCli(({ program }) => registerFactorioCli(program, pluginConfig), {
      commands: ["factorio"],
      descriptors: [{ name: "factorio", description: "Install, configure, and query Factorio through the OpenClaw runtime", hasSubcommands: true }],
    });

    api.registerTool({
      name: "factorio_setup",
      label: "Factorio Setup",
      description: "Install the bundled OpenClaw Factorio runtime mod, configure local RCON in Factorio config.ini, and store local RCON credentials for OpenClaw. This edits local Factorio config and requires a Factorio restart.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          modsDir: { type: "string" },
          factorioConfigPath: { type: "string" },
          host: { type: "string", default: DEFAULT_HOST },
          port: { type: "number", default: DEFAULT_PORT },
          password: { type: "string", description: "Optional password; generated when omitted." },
          credentialPath: { type: "string" },
          skipMod: { type: "boolean" },
          skipConfig: { type: "boolean" },
        },
      },
      async execute(_callId, params) {
        const result = await setupFactorio(params || {});
        return textResult(`Factorio runtime setup complete.\nMod: ${result.modPath || "skipped"}\nConfig: ${result.configPath || "skipped"}\nCredentials: ${result.credentialPath}\nRestart Factorio, enable openclaw-runtime if prompted, then load your save.`, result);
      },
    });

    api.registerTool({
      name: "factorio_status",
      label: "Factorio Status",
      description: "Check local OpenClaw Factorio runtime install, credential, and RCON connectivity status.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async execute() {
        const cfg = await resolveRconConfig(pluginConfig);
        const status = {
          modsDir: defaultModsDir(),
          modInstalled: existsSync(join(defaultModsDir(), MOD_FILE_NAME)),
          factorioConfigPath: defaultConfigPath(),
          factorioConfigExists: existsSync(defaultConfigPath()),
          credentialPath: cfg.credentialPath,
          credentialExists: existsSync(cfg.credentialPath),
          rcon: { host: cfg.host, port: cfg.port, passwordConfigured: Boolean(cfg.password), ok: false, error: null },
        };
        try {
          await runRconCommand(pluginConfig, `/c rcon.print("openclaw-rcon-ok")`);
          status.rcon.ok = true;
        } catch (error) {
          status.rcon.error = error.message;
        }
        return jsonResult(status);
      },
    });

    api.registerTool({
      name: "factorio_runtime",
      label: "Factorio Runtime",
      description: "Safely interact with a running Factorio game through the OpenClaw runtime mod over local RCON. Read-only actions include capabilities, players, state, inventory, selected_entity, nearby, resources, production, force_state, research, technologies, recipes, prototypes_search, and surface_info. Mutating actions require confirmed=true unless plugin config disables confirmation: craft, give_item, remove_item, place_entity, destroy_selected, mine_selected, move. chat is safe.",
      parameters: FactorioRuntimeParameters,
      async execute(_callId, params) {
        const normalized = normalizeActionParams(params || {});
        if (MUTATING_ACTIONS.has(normalized.action) && mutationRequiresConfirmation(pluginConfig, params || {})) {
          return textResult(`Confirmation required before Factorio mutating action: ${normalized.action}. Ask the user to confirm, then retry with confirmed=true. To disable this guard, set plugins.entries.openclaw-factorio-runtime.config.requireConfirmationForMutatingActions=false (or allowMutationsWithoutConfirmation=true).`, { action: normalized.action, confirmationRequired: true });
        }
        const data = await callRuntime(pluginConfig, normalized.apiName, normalized.args);
        return typeof data === "string" ? textResult(data) : jsonResult(data);
      },
    });
  },
});
