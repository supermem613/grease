#!/usr/bin/env node
import { exportCanvas } from "../.github/extensions/grease/core/canvas.mjs";
import { getFriction, pathsForStore, readCatalog, searchCatalog, updateFriction } from "../.github/extensions/grease/core/catalog.mjs";
import { buildBrief } from "../.github/extensions/grease/core/brief.mjs";
import { buildSessionRequest } from "../.github/extensions/grease/core/session-request.mjs";

const VERSION = "0.1.0";

const registry = [
  command(["schema"], "Emit the Grease command catalog.", "read"),
  command(["doctor"], "Run Grease health checks.", "read"),
  command(["status"], "Show catalog counts and paths.", "read"),
  command(["search"], "Search friction items.", "read", ["query"], ["--status", "--limit"]),
  command(["get"], "Get one friction item with occurrences.", "read", ["id"]),
  command(["update"], "Update a friction item.", "mutate-local", ["id"], ["--status", "--severity", "--tag", "--note"]),
  command(["brief"], "Generate a kickoff prompt from friction items.", "read", [], ["--id", "--query", "--status", "--limit"]),
  command(["session-request"], "Generate a structured session request.", "read", [], ["--id", "--query", "--status", "--limit"]),
  command(["export-canvas"], "Export the Grease HTML board.", "mutate-local", [], ["--output"])
];

try {
  const argv = process.argv.slice(2);
  const name = argv.shift() ?? "help";
  const result = await dispatch(name, argv);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    command: "grease",
    error: error.message,
    hint: "Run `grease schema --summary` to inspect supported commands."
  })}\n`);
  process.exitCode = 1;
}

async function dispatch(name, argv) {
  const parsed = parseArgs(argv);
  if (name === "help" || name === "--help") {
    return ok("help", { usage: "grease <schema|doctor|status|search|get|update|brief|session-request|export-canvas>" });
  }
  if (name === "schema") {
    return ok("schema", schema(parsed.flags.summary === true));
  }
  if (name === "doctor") {
    return {
      ok: true,
      checks: [
        { name: "node", ok: true, detail: `Node ${process.version}`, hint: "Install Node 22 or later." },
        { name: "catalog", ok: true, detail: pathsForStore().root, hint: "Run grease status to initialize the catalog." }
      ]
    };
  }
  if (name === "status") {
    const catalog = await readCatalog();
    return ok("status", {
      counts: {
        total: catalog.items.length,
        open: catalog.items.filter((item) => item.status === "open").length
      },
      paths: pathsForStore()
    });
  }
  if (name === "search") {
    const result = await searchCatalog({
      query: parsed.positionals.join(" ") || parsed.flags.query,
      status: parsed.flags.status,
      limit: numberFlag(parsed.flags.limit)
    });
    return ok("search", { items: result.items });
  }
  if (name === "get") {
    const id = parsed.positionals[0];
    if (!id) throw new Error("get requires an id");
    return ok("get", await getFriction(id));
  }
  if (name === "update") {
    const id = parsed.positionals[0];
    if (!id) throw new Error("update requires an id");
    const tags = arrayFlag(parsed.flags.tag);
    const result = await updateFriction(id, {
      status: parsed.flags.status,
      severity: parsed.flags.severity,
      tags: tags.length > 0 ? tags : undefined,
      note: parsed.flags.note
    });
    return ok("update", {
      eventId: result.event.id,
      itemCount: result.catalog.items.length
    });
  }
  if (name === "brief") {
    return ok("brief", await buildBrief(requestInput(parsed)));
  }
  if (name === "session-request") {
    return ok("session-request", await buildSessionRequest(requestInput(parsed)));
  }
  if (name === "export-canvas") {
    return ok("export-canvas", await exportCanvas({ outputPath: parsed.flags.output }));
  }
  throw new Error(`Unknown command: ${name}`);
}

function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        flags[key] = true;
      } else if (flags[key] === undefined) {
        flags[key] = next;
        index += 1;
      } else if (Array.isArray(flags[key])) {
        flags[key].push(next);
        index += 1;
      } else {
        flags[key] = [flags[key], next];
        index += 1;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

function requestInput(parsed) {
  return {
    ids: arrayFlag(parsed.flags.id),
    query: parsed.flags.query,
    status: parsed.flags.status,
    limit: numberFlag(parsed.flags.limit)
  };
}

function arrayFlag(value) {
  if (value === undefined || value === true) return [];
  return Array.isArray(value) ? value : [value];
}

function numberFlag(value) {
  if (value === undefined || value === true) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`Expected integer, got ${value}`);
  return number;
}

function schema(summary) {
  if (summary) {
    return {
      schemaVersion: 1,
      cliVersion: VERSION,
      commandCount: registry.length,
      commandPaths: registry.map((entry) => entry.path)
    };
  }
  return {
    schemaVersion: 1,
    cliVersion: VERSION,
    envelope: {
      stdout: "JSON only for non-interactive commands",
      stderr: "progress, diagnostics, and human narration",
      successEnvelope: ["ok", "command", "data"],
      errorEnvelope: ["ok", "command", "error", "hint"]
    },
    globalFlags: [],
    commands: registry,
    errorCodes: [],
    exitCodes: [
      { code: 0, meaning: "success" },
      { code: 1, meaning: "failure" }
    ]
  };
}

function command(path, summary, effect, positionals = [], flags = []) {
  return {
    path,
    summary,
    effect,
    input: {
      positionals: positionals.map((name) => ({ name })),
      flags: flags.map((name) => ({ name }))
    },
    output: { documented: true }
  };
}

function ok(name, data) {
  return { ok: true, command: name, data };
}
