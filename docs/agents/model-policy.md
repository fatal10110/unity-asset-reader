# Agent model policy

Optimize for correctly completed issues per subscription usage window. The roles below are
hypotheses to test here, not measured facts about this repository.

| Role | Model | Why |
| --- | --- | --- |
| Main session, implementation, review | session model | correctness of ports and reviews decides the outcome |
| `upstream-lookup` | Haiku, 25 turns | one exact fact; in the acis_golang benchmark (2026-10-13) Haiku answered narrow reference lookups with fewer wrong details than Sonnet, at about 1/16 of the cost |
| `upstream-researcher` | Sonnet, high effort, 60 turns | multi-file behavior; high effort had no wrong details where medium had one, at about 1.5× the tokens (same benchmark) |
| `wave-brief` | Sonnet | gathers facts for a lane, designs nothing |
| `wave-merge`, `wave-coord`, `wave-deliver`, `wave-runner`, `wave-scout` | Haiku | mechanical: run given commands, poll, locate, report |

- Medium effort for ordinary work; escalate only for hard debugging, high-risk review or a major
  design decision.
- Ordinary work: one main agent plus at most one research agent. A `waves` run is the explicit
  exception, and its size is bounded by the workflow cap (two agents per workflow on this
  4-CPU machine).
- The agent files use model aliases (`haiku`, `sonnet`, `inherit`), so each role follows the
  newest model of its family. Before changing a role's model, check that the runtime can spawn
  it as a subagent; if an override is unavailable, remove it and let the role inherit, and say
  so.
- Before reversing an assignment, measure it here: the same task on both arms, scored against a
  verified answer (an upstream fact checked in the source, or the findings of a saved review).
