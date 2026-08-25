# Keep bloodline messages on hierarchy geometry

Status: ready-for-agent

`toFlowEdges` marks every message as a peer arc and bypasses `isPeerMessage`. Ancestor and descendant
messages must use step geometry as required by ADR 0002; only messages outside one another's
bloodline use peer arcs.

Acceptance: conversion tests agree with predicate tests for ancestor, descendant, sibling, and
unrelated messages.
