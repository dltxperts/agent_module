# Agent Docs

This directory contains the implementation-oriented design notes for the future
native Magnis agent.

## Reading Order

1. [Phase 1 Implementation Sketch](./phase-1-implementation-sketch.md)

## Current Focus

The immediate goal is to improve the current thin sidecar without overbuilding.

Phase 1 is intentionally narrow:

- build a backend-owned `ContextEnvelopeBuilder`;
- build an `EpisodeSummaryService`;
- add episode transcript search;
- add context metrics.

These features should mostly live in the Rust backend, with only minimal
changes in `agent/` itself.

