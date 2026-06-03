# Phase 1 Implementation Sketch

## Purpose

This document makes Phase 1 concrete.

Phase 1 includes:

- `ContextEnvelopeBuilder`
- `EpisodeSummaryService`
- episode transcript search
- context metrics

The goal is to deliver these without a large rewrite and without locking the
system into a framework decision too early.

## Main Rule

Phase 1 should be implemented mostly in the Rust backend.

Why:

- the backend is already the source of truth;
- episode persistence already lives there;
- graph lookups already live there;
- search infrastructure already lives there;
- approval and tool policy already live there.

The TypeScript `agent/` runtime should stay thin in Phase 1.

## What Should Change Where

## Backend

Phase 1 should primarily land in:

- `backend/src/services/agents/`
- `backend/src/modules/episodes/`
- `backend/src/api/websocket/controllers/chat.rs`
- `backend/src/state.rs`

## Agent Sidecar

Phase 1 should only require modest changes in:

- `agent/src/server/service.ts`
- `agent/src/engines/types.ts`
- optionally `agent/src/prompts/context.ts`

The sidecar should consume a richer context object, not compute it.

## Frontend

Phase 1 frontend changes should be minimal.

The frontend should continue sending raw UI hints, for example:

- selected entity id;
- selected chat id;
- active module;
- episode id;
- reply target.

The backend should turn those hints into model-facing context.

## Proposed File Layout

This is the concrete backend layout I would use.

## New backend files

Under `backend/src/services/agents/`:

- `mod.rs`
- `service.rs` existing
- `types.rs` existing
- `context.rs`
- `context_types.rs`
- `summary.rs`
- `summary_types.rs`
- `metrics.rs`

Under `backend/src/modules/episodes/`:

- `repo.rs` extend existing
- `service.rs` extend existing
- `types.rs` extend existing

Potential migration files:

- `migrations/<ts>_episode_summaries.sql`
- later, not necessarily in Phase 1: `migrations/<ts>_memory_records.sql`

## New TypeScript-side files

Under `agent/src/`:

- `engines/types.ts` extend existing
- `server/service.ts` update existing

No big new runtime subsystem is needed for Phase 1.

## Concrete Responsibilities

## 1. `ContextEnvelopeBuilder`

Recommended file:

- `backend/src/services/agents/context.rs`

Purpose:

- assemble the full model-facing context for a turn;
- normalize and enrich frontend UI hints;
- keep prompt context bounded and structured.

Suggested input:

- raw frontend `context`;
- active `episode_id`;
- current user message;
- backend services from `AppState`.

Suggested output:

- `ContextEnvelope`

Recommended type location:

- `backend/src/services/agents/context_types.rs`

Suggested shape:

```rust
pub struct ContextEnvelope {
    pub ui_focus: UiFocus,
    pub episode: Option<EpisodeContext>,
    pub summary: Option<EpisodeSummaryView>,
    pub recent_messages: Vec<RecentMessageView>,
    pub linked_entities: Vec<LinkedEntityView>,
    pub pending_approvals: Vec<PendingApprovalView>,
    pub context_metrics: ContextMetrics,
}
```

For Phase 1, keep it intentionally small.

Do not include durable memory yet.
Do not include project checklists yet.
Do not include note fragments yet.

Those come later.

## What `ContextEnvelopeBuilder` should actually do in Phase 1

Given current backend structure, it should:

1. resolve selected entity name if only id is present;
2. load the active episode if `episode_id` exists;
3. load a compact episode summary if one exists;
4. load the last `N` meaningful messages from the episode;
5. load linked entities already associated with the episode;
6. inspect tool messages with `pending_approval` state;
7. calculate rough token and section-size metrics.

## Concrete backend API

Add a new method to the agent service layer:

```rust
impl AgentChatService {
    async fn build_context_envelope(&self, request: &ChatRequest) -> ContextEnvelope
}
```

This should be called from inside `run_stream` before sending the sidecar body.

## 2. `EpisodeSummaryService`

Recommended file:

- `backend/src/services/agents/summary.rs`

Purpose:

- maintain compact working summaries for episodes;
- provide resume-safe working state;
- reduce dependence on long raw history.

Recommended type location:

- `backend/src/services/agents/summary_types.rs`

Suggested shape:

```rust
pub struct EpisodeSummaryRecord {
    pub episode_id: Uuid,
    pub objective: Option<String>,
    pub current_state: String,
    pub recent_decisions: Vec<String>,
    pub failed_approaches: Vec<String>,
    pub open_questions: Vec<String>,
    pub next_step: Option<String>,
    pub refreshed_at: DateTime<Utc>,
}
```

For Phase 1, store this as one SQLite row with JSON columns or one JSON blob.

Do not over-normalize yet.

## Storage plan

Add a new table:

```sql
CREATE TABLE episode_summaries (
  episode_id TEXT PRIMARY KEY,
  summary_json TEXT NOT NULL,
  refreshed_at TEXT NOT NULL
);
```

That is enough for Phase 1.

You can always split fields later if they need queryability.

## Repository location

The lowest-friction place is to extend:

- `backend/src/modules/episodes/repo.rs`

with summary repository methods, because episodes are already persisted there.

Suggested additions:

```rust
async fn get_summary(&self, episode_id: Uuid) -> anyhow::Result<Option<EpisodeSummaryRecord>>;
async fn upsert_summary(&self, summary: &EpisodeSummaryRecord) -> anyhow::Result<()>;
```

## When to refresh summaries

For Phase 1, use simple trigger rules:

- after assistant `done`;
- after every `M` new persisted messages;
- after any tool call that changes episode status to `needs_input`;
- before returning episode detail on resume if the summary is stale.

Suggested initial thresholds:

- refresh if at least 6 new messages since last summary;
- or if at least 3 tool call/result pairs since last summary;
- or if no summary exists.

## Where to call it

The easiest path is inside:

- `backend/src/services/agents/service.rs`

specifically after the stream completes and the assistant message has been persisted.

Pseudo-flow:

1. persist user message
2. stream sidecar events
3. persist tool traces and assistant response
4. call `EpisodeSummaryService::refresh_if_needed(episode_id)`
5. mark episode `idle`

## 3. Episode transcript search

Recommended location:

- Phase 1: `backend/src/modules/episodes/service.rs`
- Phase 2: move into dedicated `backend/src/services/agents/search.rs` if it grows

Why start in `episodes`:

- the raw message data is already stored in `agent_episode_messages`;
- the use case is episode-local and transcript-centric;
- it avoids premature service sprawl.

## Minimal Phase 1 API

Add an episode search method:

```rust
pub async fn search_messages(
    &self,
    query: &str,
    limit: usize,
    offset: usize,
) -> anyhow::Result<Vec<EpisodeMessageSearchHit>>
```

Suggested hit shape:

```rust
pub struct EpisodeMessageSearchHit {
    pub episode_id: Uuid,
    pub message_id: Uuid,
    pub role: String,
    pub excerpt: String,
    pub created_at: DateTime<Utc>,
}
```

## Implementation path

Use SQLite directly over `agent_episode_messages`.

Phase 1 can start with:

- `LIKE` or simple FTS if you already want to wire it cleanly.

Best practical option:

- add an FTS5 virtual table over persisted episode message content.

Even if you do not add semantic retrieval yet, keyword transcript search is
already valuable for:

- finding earlier agreements;
- finding prior replies;
- finding tool outputs from this episode;
- building better summaries.

## Exposed surfaces

Add at least one of these:

- `episodes.search_messages`
- `episodes.search`

I would prefer `episodes.search_messages` now because it is explicit.

## 4. Context metrics

Recommended file:

- `backend/src/services/agents/metrics.rs`

Purpose:

- make context visible;
- prepare for compaction and memory retrieval later;
- avoid blind context growth.

## What to measure in Phase 1

At minimum:

- estimated tokens from recent messages;
- estimated tokens from episode summary;
- count of linked entities included;
- count of pending approvals included;
- total sections included in context envelope;
- per-section rough size.

Suggested type:

```rust
pub struct ContextMetrics {
    pub estimated_total_tokens: usize,
    pub recent_messages_tokens: usize,
    pub summary_tokens: usize,
    pub linked_entities_tokens: usize,
    pub pending_approvals_tokens: usize,
}
```

## Where metrics should be computed

Inside `ContextEnvelopeBuilder`.

Why:

- it is the single place that already sees the final package;
- no other component should guess what was actually included.

## Where metrics should be exposed

Phase 1 has two good options:

### Option A

Attach them to the internal `ContextEnvelope` only and log server-side.

This is the fastest and lowest-risk path.

### Option B

Add a developer-facing RPC:

- `agent.context_preview`

This would return:

- the built context envelope;
- section sizes;
- rough token counts.

I strongly recommend this.

It will make debugging much easier.

## Minimal TypeScript Changes

Phase 1 should avoid putting logic into the sidecar.

## `agent/src/engines/types.ts`

Extend `UIContext` support or replace it with a richer payload:

```ts
export interface ContextEnvelope {
  ui_focus: ...
  episode?: ...
  summary?: ...
  recent_messages: ...
  linked_entities: ...
  pending_approvals: ...
  context_metrics: ...
}
```

Then the engine request becomes:

- either `context?: ContextEnvelope`
- or `context_envelope?: ContextEnvelope`

I prefer `context_envelope` so it is obvious this is backend-built.

## `agent/src/server/service.ts`

Change behavior from:

- build seed string from thin `UIContext`

to:

- render a structured prompt section from backend-built `ContextEnvelope`.

Important:

- the sidecar should still only render it;
- it should not decide what belongs there.

## `agent/src/prompts/context.ts`

This file can stay, but it should become a renderer:

- input: `ContextEnvelope`
- output: compact prompt text

That keeps prompt formatting in TypeScript while keeping context selection in Rust.

## Concrete Flow For Phase 1

This is the exact flow I would implement first.

### Request Path

1. Frontend sends `chat.stream` request with raw UI hints.
2. `backend/src/api/websocket/controllers/chat.rs` keeps doing light normalization only.
3. `backend/src/services/agents/service.rs` calls `build_context_envelope`.
4. The built envelope is inserted into the sidecar request body.
5. Sidecar renders the envelope into prompt text.
6. Model runs normally.
7. Backend persists messages as it already does.
8. Backend refreshes episode summary after the turn.

### Resume Path

1. Frontend loads latest episode.
2. Backend returns the stored episode summary with episode detail.
3. New turn uses that summary in the context envelope.

### Search Path

1. Debug or internal tool calls `episodes.search_messages`.
2. Results can later feed summary or memory extraction.

## Suggested Initial RPC Additions

I would add these in Phase 1:

- `episodes.search_messages`
- `episodes.summary.get`
- `episodes.summary.refresh`
- `agent.context_preview`

The last one is especially useful during development.

## Suggested Concrete File Diffs

If I were implementing this next, I would touch these files first.

## Backend

- `backend/src/services/agents/mod.rs`
  - export new modules
- `backend/src/services/agents/context.rs`
  - new
- `backend/src/services/agents/context_types.rs`
  - new
- `backend/src/services/agents/summary.rs`
  - new
- `backend/src/services/agents/summary_types.rs`
  - new
- `backend/src/services/agents/metrics.rs`
  - new
- `backend/src/services/agents/service.rs`
  - call context builder and summary refresh
- `backend/src/modules/episodes/repo.rs`
  - summary persistence methods
- `backend/src/modules/episodes/service.rs`
  - transcript search methods
- `backend/src/modules/episodes/controller.rs`
  - new RPC/tool surfaces
- `backend/src/state.rs`
  - wire new services into `AppState`

## Agent

- `agent/src/engines/types.ts`
  - richer context type
- `agent/src/server/service.ts`
  - use context envelope instead of thin UI context
- `agent/src/prompts/context.ts`
  - render context envelope

## What I Would Not Build Yet

Do not add these in Phase 1:

- durable cross-session memory storage;
- memory extraction workers;
- background consolidation;
- plan/checklist persistence;
- subagents;
- framework migration.

Those are all real next steps, but they should sit on top of a stable context
and episode-summary foundation.

## Example Of The Phase 1 Boundary

At the end of Phase 1, the native agent should still be simple:

- one main runtime;
- one backend-built context package;
- one persisted episode summary;
- one transcript search surface;
- one metrics surface.

That is enough to materially improve long-turn quality without overbuilding.

## Recommended Sequence

Implement in this order:

1. `episode_summaries` table and repository methods
2. `EpisodeSummaryService`
3. `ContextEnvelopeBuilder`
4. sidecar support for `context_envelope`
5. `episodes.search_messages`
6. `agent.context_preview`
7. metrics logging and tuning

This order keeps each step testable and useful on its own.

