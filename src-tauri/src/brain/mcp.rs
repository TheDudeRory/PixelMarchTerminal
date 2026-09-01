//! MCP (Model Context Protocol) over the brain's own listener.
//!
//! WHAT THIS IS: one more path into the SAME bus, not a second bus. Every tool
//! below is a thin wrapper over the function that already backs an HTTP route in
//! `mod.rs` — `create_task`, `claim_task`, `set_task_status`, `remember`, `note`,
//! `patch_note`, `recall`, `chat_send`, `reset_request`. No new storage, no second
//! copy of the task rules, and nothing an MCP client can do that a `curl` cannot.
//! An agent whose CLI speaks MCP gets typed results; one whose CLI does not keeps
//! curling the routes, and the two see the same state note for note.
//!
//! WHY IT EXISTS AT ALL: a claim collision used to be prose an agent had to read
//! and believe ("ok:false … pick another"). As a tool result it is a value —
//! `claimed:false` with a `reason` — which is the difference between a losing
//! racer noticing and a losing racer improvising.
//!
//! TRANSPORT: streamable HTTP, POST-only, on the existing port behind the existing
//! token (`handle` authenticates before `route` is ever reached, so there is no
//! auth code here — and nothing to get subtly different from the rest of the bus).
//! GET /mcp answers 405: this server opens no server-initiated SSE stream.
//!
//! TOKEN COST: these schemas are injected into EVERY turn of every MCP pane. That
//! is the budget this surface is spending, so descriptions are ONE LINE each and
//! a new tool has to earn its place — measure before adding a thirteenth.

use serde_json::{json, Value};

/// The MCP revision this server implements. Clients that ask for an older one we
/// recognise are answered in their own version; anything else is answered here,
/// which is what the spec asks for (the client then decides whether to proceed).
const PROTOCOL_VERSION: &str = "2025-06-18";
const SUPPORTED_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/// JSON-RPC error codes we emit.
const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;

/// One POSTed JSON-RPC message → (HTTP status, body). A notification (no `id`)
/// gets `202` and an EMPTY body, which is how the caller learns it was accepted
/// without being handed a response it must not correlate.
/// Trusted-caller shim — the tests' entry point (no agent identity).
#[cfg(test)]
pub fn rpc(body: &str) -> (u16, String) {
    rpc_as(body, None)
}

/// The real dispatcher. `actor` = the agent identity the request's token
/// resolved to (a swarm pane), threaded into every task-bus tool so the same
/// lifecycle rules gate MCP and curl identically.
pub fn rpc_as(body: &str, actor: Option<&super::Actor>) -> (u16, String) {
    let msg: Value = match serde_json::from_str(body.trim()) {
        Ok(v) => v,
        Err(e) => return (400, err_body(Value::Null, PARSE_ERROR, &format!("invalid JSON: {e}"))),
    };
    // Batches were dropped from the protocol in 2025-06-18, and supporting them
    // here would mean a second response shape for no caller that exists.
    if msg.is_array() {
        return (400, err_body(Value::Null, INVALID_REQUEST, "batch requests are not supported — send one JSON-RPC message"));
    }
    let method = msg["method"].as_str().unwrap_or("").to_string();
    let id = msg.get("id").cloned().unwrap_or(Value::Null);
    let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));

    // No id = notification. Nothing to answer, including `notifications/initialized`.
    if msg.get("id").is_none() {
        return (202, String::new());
    }

    match method.as_str() {
        "initialize" => {
            let asked = params["protocolVersion"].as_str().unwrap_or(PROTOCOL_VERSION);
            let version = if SUPPORTED_VERSIONS.contains(&asked) { asked } else { PROTOCOL_VERSION };
            ok_body(id, json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "pixelmarch-brain", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "Swarm bus + shared memory. Tasks: tasks_list/task_create/task_claim/task_status. Memory: note_get/note_set/note_patch/recall/plan_get. Coordination: chat_send/chat_inbox/reset_request. Same state the HTTP routes serve.",
            }))
        }
        "ping" => ok_body(id, json!({})),
        "tools/list" => ok_body(id, json!({ "tools": tools() })),
        "tools/call" => {
            let name = params["name"].as_str().unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            let (structured, is_error) = call(name, &args, actor);
            ok_body(id, json!({
                // `content` is what a model without structured-output support reads,
                // `structuredContent` is the same value typed. They are generated
                // from ONE object so they can never disagree.
                "content": [{ "type": "text", "text": serde_json::to_string(&structured).unwrap_or_else(|_| "null".into()) }],
                "structuredContent": structured,
                "isError": is_error,
            }))
        }
        "" => (400, err_body(id, INVALID_REQUEST, "not a JSON-RPC request: no method")),
        other => err_body_status(id, METHOD_NOT_FOUND, &format!("unknown method {other:?}")),
    }
}

fn ok_body(id: Value, result: Value) -> (u16, String) {
    (200, super::pretty(&json!({ "jsonrpc": "2.0", "id": id, "result": result })))
}

fn err_body(id: Value, code: i64, message: &str) -> String {
    super::pretty(&json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }))
}

fn err_body_status(id: Value, code: i64, message: &str) -> (u16, String) {
    (200, err_body(id, code, message))
}

// ── the tool surface ────────────────────────────────────────────────────────

fn str_schema(desc: &str) -> Value {
    json!({ "type": "string", "description": desc })
}

/// Schema helper: `props` = (name, schema, required).
fn tool(name: &str, desc: &str, props: &[(&str, Value, bool)]) -> Value {
    let mut properties = serde_json::Map::new();
    let mut required: Vec<String> = Vec::new();
    for (k, schema, req) in props {
        properties.insert((*k).to_string(), schema.clone());
        if *req {
            required.push((*k).to_string());
        }
    }
    json!({
        "name": name,
        "description": desc,
        "inputSchema": { "type": "object", "properties": Value::Object(properties), "required": required },
    })
}

/// The twelve tools. Descriptions are ONE line on purpose — see the token note
/// at the top of this file.
fn tools() -> Vec<Value> {
    let project = || ("project", str_schema("swarm project name"), true);
    vec![
        tool("tasks_list", "List the task bus, optionally narrowed by status (csv), role and owner.", &[
            project(),
            ("status", str_schema("open|claimed|done|approved|changes|blocked|merged|cancelled, comma-separated"), false),
            ("role", str_schema("builder|scout|reviewer|coordinator"), false),
            // The dispatch arm has always forwarded `owner`; leaving it out of the
            // schema meant a model following the published contract dropped it and
            // saw EVERY role's tasks — the builder feedback check reads
            // {status: "changes", owner: "builder-N"} and would retake someone else's.
            ("owner", str_schema("role that owns the task, e.g. builder-2"), false),
        ]),
        tool("task_create", "Create a task; builder tasks default to blocked until explicitly opened. Refused when files overlap a live task — patch that task's desc instead.", &[
            project(),
            ("desc", str_schema("what the task is"), true),
            ("files", str_schema("files this task owns; must not overlap an open/claimed/changes task"), false),
            ("role", str_schema("role the task belongs to (default builder)"), false),
            ("status", str_schema("initial status (default blocked, or open for scout)"), false),
        ]),
        tool("task_claim", "Claim a task; returns claimed:false with a reason when someone else has it.", &[
            project(),
            ("task", str_schema("task key, e.g. task-3"), true),
            ("owner", str_schema("your role, e.g. builder-1"), true),
        ]),
        tool("task_status", "Move a task to done/approved/changes/blocked/open, with an optional log line.", &[
            project(),
            ("task", str_schema("task key"), true),
            ("status", str_schema("done|approved|changes|blocked|open"), true),
            ("log", str_schema("one line appended to the task"), false),
            ("owner", str_schema("reassign the owner"), false),
        ]),
        tool("note_get", "Read one note.", &[project(), ("key", str_schema("note key"), true)]),
        tool("note_set", "Write one note, replacing what was there.", &[
            project(),
            ("key", str_schema("note key"), true),
            ("value", str_schema("the note body"), true),
        ]),
        tool("note_patch", "Replace text inside a note without resending the whole body.", &[
            project(),
            ("key", str_schema("note key"), true),
            ("find", str_schema("literal text to find"), true),
            ("replace", str_schema("what to put there"), false),
            ("dry", json!({ "type": "boolean", "description": "preview only, write nothing" }), false),
        ]),
        tool("recall", "Search this project's notes (and point at matches elsewhere).", &[
            project(),
            ("q", str_schema("search words"), true),
        ]),
        tool("chat_send", "Send a swarm message to a role, or to all.", &[
            project(),
            ("to", str_schema("role name, several as a|b, or all"), true),
            ("text", str_schema("the message"), true),
            ("from", str_schema("your role"), true),
        ]),
        tool("chat_inbox", "Messages addressed to you or to all, already routed.", &[
            project(),
            ("role", str_schema("your role"), true),
            ("since", json!({ "type": "integer", "description": "epoch-seconds cursor, exclusive" }), false),
        ]),
        tool("reset_request", "Ask the host to re-brief you with a fresh context.", &[
            project(),
            ("role", str_schema("your role"), true),
        ]),
        tool("plan_get", "Read the swarm's plan note.", &[project()]),
    ]
}

// ── argument helpers ────────────────────────────────────────────────────────

fn s(args: &Value, k: &str) -> String {
    args.get(k).and_then(Value::as_str).unwrap_or_default().trim().to_string()
}

fn b(args: &Value, k: &str, default: bool) -> bool {
    args.get(k)
        .map(|v| v.as_bool().unwrap_or_else(|| matches!(v.as_str(), Some("true" | "1" | "yes" | "on"))))
        .unwrap_or(default)
}

fn u(args: &Value, k: &str) -> u64 {
    args.get(k)
        .and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())))
        .unwrap_or(0)
}

/// `(structuredContent, isError)`. `isError` means the CALL was wrong — a missing
/// argument, an unknown tool. A refused claim or a missing note is a real answer,
/// not an error: the whole point of the tool surface is that the caller gets a
/// value to branch on instead of prose to interpret.
fn call(name: &str, args: &Value, actor: Option<&super::Actor>) -> (Value, bool) {
    let project = s(args, "project");
    if project.is_empty() {
        return (json!({ "ok": false, "error": "need project" }), true);
    }
    let need = |k: &str| -> Result<String, (Value, bool)> {
        let v = s(args, k);
        if v.is_empty() {
            Err((json!({ "ok": false, "error": format!("need {k}") }), true))
        } else {
            Ok(v)
        }
    };
    macro_rules! req {
        ($k:expr) => {
            match need($k) {
                Ok(v) => v,
                Err(e) => return e,
            }
        };
    }

    match name {
        "tasks_list" => {
            let mut pairs = vec![("project".to_string(), project)];
            for k in ["status", "role", "owner", "mine"] {
                let v = s(args, k);
                if !v.is_empty() {
                    pairs.push((k.to_string(), v));
                }
            }
            let rows = super::filtered_tasks(&pairs);
            (json!({ "ok": true, "count": rows.len(), "tasks": rows }), false)
        }
        "task_create" => {
            let desc = req!("desc");
            (super::create_task_as(&project, &desc, &s(args, "files"), &s(args, "status"), &s(args, "role"), actor), false)
        }
        "task_claim" => {
            let (task, owner) = (req!("task"), req!("owner"));
            let out = super::claim_task_as(&project, &task, &owner, actor);
            // Flattened for the caller: `claimed` is the branch, `reason` is why not.
            let claimed = out["ok"] == json!(true);
            let reason = out
                .get("reason")
                .and_then(Value::as_str)
                .or_else(|| out.get("error").and_then(Value::as_str))
                .unwrap_or("")
                .to_string();
            let mut v = json!({ "claimed": claimed, "task": task, "owner": owner, "project": project });
            if !claimed {
                v["reason"] = json!(reason);
                v["status"] = out.get("status").cloned().unwrap_or(Value::Null);
                v["held_by"] = out.get("owner").cloned().unwrap_or(Value::Null);
                if let Some(h) = out.get("hint") {
                    v["hint"] = h.clone();
                }
            }
            (v, false)
        }
        "task_status" => {
            let (task, status) = (req!("task"), req!("status"));
            let owner = s(args, "owner");
            let owner = if owner.is_empty() { None } else { Some(owner) };
            (super::set_task_status_as(&project, &task, &status, owner.as_deref(), &s(args, "log"), actor, None), false)
        }
        "note_get" => {
            let key = req!("key");
            match super::note(&project, &key) {
                Some(value) => (json!({ "ok": true, "project": project, "key": key, "found": true, "value": value }), false),
                None => (json!({ "ok": true, "project": project, "key": key, "found": false, "value": Value::Null }), false),
            }
        }
        "note_set" => {
            let (key, value) = (req!("key"), req!("value"));
            (super::remember_as(&project, &key, &value, true, actor), false)
        }
        "note_patch" => {
            let (key, find) = (req!("key"), req!("find"));
            (
                super::patch_note(&project, &key, "", &find, &s(args, "replace"), "", "", true, false, "", b(args, "dry", false)),
                false,
            )
        }
        "recall" => {
            let q = req!("q");
            let mut rows = super::recall(&project, None, Some(&q));
            rows.extend(super::cross_project(&project, &q));
            (json!({ "ok": true, "count": rows.len(), "results": rows }), false)
        }
        "chat_send" => {
            let (to, text, from) = (req!("to"), req!("text"), req!("from"));
            (super::chat_send_as(&project, &from, &to, &text, actor), false)
        }
        "chat_inbox" => {
            let role = req!("role");
            let rows = super::chat_inbox(&project, &role, u(args, "since"));
            (json!({ "ok": true, "count": rows.len(), "messages": rows }), false)
        }
        "reset_request" => {
            let role = req!("role");
            (super::reset_request_as(&project, &role, actor), false)
        }
        "plan_get" => match super::note(&project, "plan") {
            Some(plan) => (json!({ "ok": true, "project": project, "found": true, "plan": plan }), false),
            None => (
                json!({ "ok": true, "project": project, "found": false, "plan": Value::Null,
                        "hint": "no plan note yet — builder claims are refused until the coordinator posts one" }),
                false,
            ),
        },
        other => (
            json!({ "ok": false, "error": format!("unknown tool {other:?}"), "hint": "call tools/list" }),
            true,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn send(msg: Value) -> (u16, Value) {
        let (code, body) = rpc(&msg.to_string());
        let v: Value = if body.is_empty() { Value::Null } else { serde_json::from_str(&body).unwrap() };
        (code, v)
    }

    /// One `tools/call`, unwrapped to its structured result.
    fn call_tool(name: &str, args: Value) -> Value {
        let (code, v) = send(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": name, "arguments": args } }));
        assert_eq!(code, 200, "{v}");
        assert_eq!(v["error"], Value::Null, "transport error for {name}: {v}");
        v["result"]["structuredContent"].clone()
    }

    fn p() -> String {
        format!("_mcp_{}", std::process::id())
    }

    #[test]
    fn the_handshake_answers_with_a_version_and_a_tool_capability() {
        let (code, v) = send(json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": PROTOCOL_VERSION, "capabilities": {}, "clientInfo": { "name": "t", "version": "0" } }
        }));
        assert_eq!(code, 200);
        assert_eq!(v["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert!(v["result"]["capabilities"]["tools"].is_object(), "{v}");
        assert_eq!(v["result"]["serverInfo"]["name"], "pixelmarch-brain");

        // A client on an older revision we know is answered in ITS version, not ours.
        let (_, old) = send(json!({ "jsonrpc": "2.0", "id": 2, "method": "initialize", "params": { "protocolVersion": "2024-11-05" } }));
        assert_eq!(old["result"]["protocolVersion"], "2024-11-05");
        // One we don't know falls back to what we actually implement.
        let (_, future) = send(json!({ "jsonrpc": "2.0", "id": 3, "method": "initialize", "params": { "protocolVersion": "1999-01-01" } }));
        assert_eq!(future["result"]["protocolVersion"], PROTOCOL_VERSION);

        // `notifications/initialized` carries no id: accepted, nothing to correlate.
        let (code, body) = rpc(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }).to_string());
        assert_eq!(code, 202);
        assert!(body.is_empty(), "a notification must get no response body: {body}");
    }

    #[test]
    fn malformed_and_unknown_messages_are_refused_by_shape_not_by_guess() {
        let (code, v) = rpc("not json at all");
        assert_eq!(code, 400);
        let v: Value = serde_json::from_str(&v).unwrap();
        assert_eq!(v["error"]["code"], PARSE_ERROR);

        let (code, _) = rpc(&json!([{ "jsonrpc": "2.0", "id": 1, "method": "ping" }]).to_string());
        assert_eq!(code, 400, "batches are not supported and must say so");

        let (code, v) = send(json!({ "jsonrpc": "2.0", "id": 9, "method": "tools/nope" }));
        assert_eq!(code, 200);
        assert_eq!(v["error"]["code"], METHOD_NOT_FOUND);
        assert_eq!(v["id"], 9, "the id must come back so the client can correlate the failure");
    }

    #[test]
    fn every_advertised_tool_has_a_one_line_description_and_a_schema() {
        let (_, v) = send(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }));
        let tools = v["result"]["tools"].as_array().unwrap().clone();
        assert_eq!(tools.len(), 12, "the surface is twelve tools — adding one costs every turn");
        for t in &tools {
            let name = t["name"].as_str().unwrap();
            let desc = t["description"].as_str().unwrap();
            assert!(!desc.is_empty(), "{name} needs a description");
            assert!(!desc.contains('\n'), "{name}: descriptions are ONE line — they ride every turn");
            assert_eq!(t["inputSchema"]["type"], "object", "{name}");
            assert!(t["inputSchema"]["properties"]["project"].is_object(), "{name} must take a project");
        }
        // Every arg the dispatch reads must be DECLARED: a model follows the published
        // schema, so an undeclared filter is silently dropped and the caller gets a
        // wider answer than it asked for (builders reading each other's "changes").
        let list = tools.iter().find(|t| t["name"] == "tasks_list").unwrap();
        for arg in ["status", "role", "owner"] {
            assert!(list["inputSchema"]["properties"][arg].is_object(), "tasks_list must declare {arg}");
        }
        // And every advertised name actually dispatches.
        let names: Vec<String> = tools.iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
        for n in &names {
            let out = call_tool(n, json!({ "project": p() }));
            assert!(out.is_object(), "{n} returned nothing");
        }
    }

    /// The whole point: a tool and its HTTP route are the same bus. Each round-trip
    /// below is written through MCP and read back through the plain functions the
    /// routes call, or the other way round.
    #[test]
    fn tools_round_trip_against_the_same_state_the_http_routes_see() {
        let p = p();
        let _ = super::super::forget_project(&p);
        super::super::write_note(&p, "mission", "test mission").unwrap();
        super::super::write_note(&p, "plan", "the plan").unwrap();

        // plan_get / note_get / note_set / note_patch / recall
        assert_eq!(call_tool("plan_get", json!({ "project": p }))["plan"], "the plan");
        assert_eq!(call_tool("note_set", json!({ "project": p, "key": "n1", "value": "hello swarm" }))["ok"], true);
        assert_eq!(super::super::note(&p, "n1").unwrap(), "hello swarm", "note_set must land where the routes read");
        assert_eq!(call_tool("note_get", json!({ "project": p, "key": "n1" }))["value"], "hello swarm");
        assert_eq!(call_tool("note_get", json!({ "project": p, "key": "nope" }))["found"], false);
        assert_eq!(call_tool("note_patch", json!({ "project": p, "key": "n1", "find": "hello", "replace": "goodbye" }))["ok"], true);
        assert_eq!(super::super::note(&p, "n1").unwrap(), "goodbye swarm");
        assert!(call_tool("note_patch", json!({ "project": p, "key": "n1", "find": "goodbye", "replace": "x", "dry": true }))["dry"] == json!(true));
        assert_eq!(super::super::note(&p, "n1").unwrap(), "goodbye swarm", "a dry patch must not write");
        let hits = call_tool("recall", json!({ "project": p, "q": "goodbye" }));
        assert!(hits["count"].as_u64().unwrap() >= 1, "{hits}");

        // task_create -> tasks_list -> task_claim -> task_status, all through MCP,
        // then verified through the same `tasks()` the /tasks route serves.
        let made = call_tool("task_create", json!({ "project": p, "desc": "do a thing", "files": "a.rs", "role": "builder", "status": "open" }));
        assert_eq!(made["ok"], true, "{made}");
        let key = made["key"].as_str().unwrap().to_string();
        let listed = call_tool("tasks_list", json!({ "project": p, "status": "open", "role": "builder" }));
        assert_eq!(listed["count"], 1, "{listed}");
        assert_eq!(listed["tasks"][0]["key"], key);

        let claim = call_tool("task_claim", json!({ "project": p, "task": key, "owner": "builder-1" }));
        assert_eq!(claim["claimed"], true, "{claim}");
        assert_eq!(super::super::tasks(&p)[0]["owner"], "builder-1", "the HTTP view must see the MCP claim");

        // owner narrows server-side — the builder feedback check depends on it
        assert_eq!(call_tool("tasks_list", json!({ "project": p, "owner": "builder-1" }))["count"], 1);
        assert_eq!(call_tool("tasks_list", json!({ "project": p, "owner": "builder-2" }))["count"], 0);

        let done = call_tool("task_status", json!({ "project": p, "task": key, "status": "done", "log": "branch x" }));
        assert_eq!(done["ok"], true, "{done}");
        assert_eq!(super::super::tasks(&p)[0]["status"], "done");
        assert!(super::super::note(&p, &key).unwrap().contains("branch x"));

        // chat: sent through MCP, routed on read, and still a plain note on disk so
        // a curl-only pane and the Coordinator tab keep seeing it.
        assert_eq!(call_tool("chat_send", json!({ "project": p, "from": "builder-1", "to": "coordinator", "text": "task done" }))["ok"], true);
        assert_eq!(call_tool("chat_send", json!({ "project": p, "from": "coordinator", "to": "all", "text": "standup" }))["ok"], true);
        assert!(super::super::note(&p, "chat-builder-1-1").unwrap().starts_with("to: coordinator\n"));

        let inbox = call_tool("chat_inbox", json!({ "project": p, "role": "coordinator" }));
        assert_eq!(inbox["count"], 1, "own broadcast excluded, addressed message included: {inbox}");
        assert_eq!(inbox["messages"][0]["from"], "builder-1");
        assert_eq!(inbox["messages"][0]["text"], "task done");
        let b1 = call_tool("chat_inbox", json!({ "project": p, "role": "builder-1" }));
        assert_eq!(b1["count"], 1, "builder-1 sees the broadcast, not its own message: {b1}");
        assert_eq!(b1["messages"][0]["to"], "all");

        // A multi-recipient header reaches EVERY role it names — the swarm really
        // sends `to: builder-2|reviewer-1`, and matching the header as one opaque
        // string delivered it to nobody.
        assert_eq!(call_tool("chat_send", json!({ "project": p, "from": "coordinator", "to": "builder-2|reviewer-1", "text": "both of you" }))["ok"], true);
        for role in ["builder-2", "reviewer-1"] {
            let got = call_tool("chat_inbox", json!({ "project": p, "role": role }));
            let texts: Vec<&str> = got["messages"].as_array().unwrap().iter().map(|m| m["text"].as_str().unwrap()).collect();
            assert!(texts.contains(&"both of you"), "{role} must receive the multi-target message: {got}");
        }
        let b2 = call_tool("chat_inbox", json!({ "project": p, "role": "builder-2" }));
        let multi = b2["messages"].as_array().unwrap().iter().find(|m| m["text"] == "both of you").unwrap();
        assert_eq!(multi["to"], "builder-2|reviewer-1", "the raw header stays on the row");
        assert_eq!(multi["targets"], json!(["builder-2", "reviewer-1"]), "the parsed list rides along so nobody re-parses");
        // ...and a role it does NOT name still does not see it.
        let b1_after = call_tool("chat_inbox", json!({ "project": p, "role": "builder-1" }));
        assert!(
            !b1_after["messages"].as_array().unwrap().iter().any(|m| m["text"] == "both of you"),
            "builder-1 is not addressed: {b1_after}"
        );

        // reset_request writes the same reset-<role> note the watcher has always read.
        assert_eq!(call_tool("reset_request", json!({ "project": p, "role": "builder-1" }))["ok"], true);
        assert_eq!(super::super::note(&p, "reset-builder-1").unwrap(), "ready");
        let resets = super::super::reset_requests(&p);
        assert_eq!(resets.len(), 1);
        assert_eq!(resets[0]["role"], "builder-1");

        let _ = super::super::forget_project(&p);
    }

    /// A losing racer must get a REASON, not prose to guess at. This is the failure
    /// the tool surface exists for.
    #[test]
    fn a_losing_claim_comes_back_as_a_value_with_a_reason() {
        let p = format!("_mcp_race_{}", std::process::id());
        let _ = super::super::forget_project(&p);
        super::super::write_note(&p, "mission", "m").unwrap();
        super::super::write_note(&p, "plan", "p").unwrap();
        let key = super::super::create_task(&p, "contended", "", "open", "builder")["key"].as_str().unwrap().to_string();

        let first = call_tool("task_claim", json!({ "project": p, "task": key, "owner": "builder-1" }));
        assert_eq!(first["claimed"], true, "{first}");

        let second = call_tool("task_claim", json!({ "project": p, "task": key, "owner": "builder-2" }));
        assert_eq!(second["claimed"], false, "{second}");
        assert_eq!(second["reason"], "not claimable");
        assert_eq!(second["held_by"], "builder-1", "the loser is told WHO has it");
        assert_eq!(second["status"], "claimed");

        // Role mismatch is its own reason, not the same "not claimable".
        let scout_task = super::super::create_task(&p, "scouting", "", "open", "scout")["key"].as_str().unwrap().to_string();
        let wrong_role = call_tool("task_claim", json!({ "project": p, "task": scout_task, "owner": "builder-2" }));
        assert_eq!(wrong_role["claimed"], false);
        assert_eq!(wrong_role["reason"], "role mismatch");

        // And a claim before the plan lands says so, so a builder waits instead of
        // treating the refusal as "someone beat me".
        let np = format!("_mcp_noplan_{}", std::process::id());
        let _ = super::super::forget_project(&np);
        super::super::write_note(&np, "mission", "m").unwrap();
        let t = super::super::create_task(&np, "early", "", "open", "builder")["key"].as_str().unwrap().to_string();
        let early = call_tool("task_claim", json!({ "project": np, "task": t, "owner": "builder-1" }));
        assert_eq!(early["claimed"], false);
        assert_eq!(early["reason"], "no plan yet");

        let _ = super::super::forget_project(&p);
        let _ = super::super::forget_project(&np);
    }

    /// The coordinator creates tasks through THIS surface, so the scope guard has to
    /// bite here too — and the refusal has to arrive as a value it can read, naming
    /// the task that already owns the files.
    #[test]
    fn task_create_through_mcp_refuses_a_second_task_over_live_files() {
        let p = format!("_mcp_scope_{}", std::process::id());
        let _ = super::super::forget_project(&p);
        super::super::write_note(&p, "mission", "m").unwrap();

        let first = call_tool("task_create", json!({ "project": p, "desc": "own swarm.ts", "files": "src/lib/swarm.ts", "status": "open" }));
        assert_eq!(first["ok"], true, "{first}");

        let dup = call_tool("task_create", json!({ "project": p, "desc": "re-home it", "files": " SRC/lib/swarm.ts ", "status": "open" }));
        assert_eq!(dup["ok"], false, "{dup}");
        assert_eq!(dup["reason"], "scope overlap");
        assert_eq!(dup["task"], first["key"]);
        assert!(dup["hint"].as_str().unwrap().contains("correction-task-1-scope"), "{dup}");
        assert_eq!(super::super::tasks(&p).len(), 1, "nothing was written");

        // ...and it is a RESULT, not a protocol error: the caller branches on it.
        let (_, v) = send(json!({ "jsonrpc": "2.0", "id": 9, "method": "tools/call",
            "params": { "name": "task_create", "arguments": { "project": p, "desc": "again", "files": "src/lib/swarm.ts", "status": "open" } } }));
        assert_eq!(v["result"]["isError"], false, "{v}");
        assert_eq!(v["result"]["structuredContent"]["reason"], "scope overlap");

        let _ = super::super::forget_project(&p);
    }

    /// A call missing an argument is an ERROR (the caller is wrong); a refused claim
    /// or an absent note is a RESULT (the world is what it is). Confusing the two is
    /// how an agent starts retrying things that will never succeed.
    #[test]
    fn bad_arguments_are_errors_while_ordinary_refusals_are_results() {
        let p = p();
        let (_, v) = send(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "task_claim", "arguments": { "project": p, "task": "task-1" } } }));
        assert_eq!(v["result"]["isError"], true, "missing owner: {v}");
        assert!(v["result"]["structuredContent"]["error"].as_str().unwrap().contains("owner"));

        let (_, v) = send(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "note_get", "arguments": { "key": "k" } } }));
        assert_eq!(v["result"]["isError"], true, "missing project: {v}");

        let (_, v) = send(json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "no_such_tool", "arguments": { "project": p } } }));
        assert_eq!(v["result"]["isError"], true);

        let (_, v) = send(json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "note_get", "arguments": { "project": p, "key": "definitely-absent" } } }));
        assert_eq!(v["result"]["isError"], false, "an absent note is an answer, not an error: {v}");
        assert_eq!(v["result"]["structuredContent"]["found"], false);

        // The text content and the structured content are the same value, always.
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        let parsed: Value = serde_json::from_str(text).unwrap();
        assert_eq!(parsed, v["result"]["structuredContent"]);
    }
}
