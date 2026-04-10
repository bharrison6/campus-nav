# Murray-State-Campus-Navigation - Agent Protocol

## How to Use This Configuration

This file defines the agent workflow for this repository.

**Before working here, also read:**
- `C:\GitHub\PROTOCOL.md` — Root coordination protocol
- `STANDARDS.md` — Technical rules for this project
- `.agent-context.md` — Current project state and decisions

## Before Starting Work

1. Read `.agent-log\changelog.md` for recent activity
2. Read `.agent-log\handoffs.md` for pending tasks or blockers
3. Read `.agent-context.md` for current project state
4. Read `STANDARDS.md` for all technical rules

## During Work

- Follow all standards in STANDARDS.md strictly
- Check changelog before implementing new features
- Maintain consistency with existing code patterns

## After Completing Work

Log changes to `.agent-log\changelog.md`:
```
### [YYYY-MM-DD HH:MM] AGENT_NAME [ACTION_TYPE]
- Description of changes
- Files: <paths from repo root>
- Notes: Important context for other agents
- PENDING: (optional) What needs follow-up
```

If handing off incomplete work, update `.agent-log\handoffs.md`.

## Repository Structure

```
Murray-State-Campus-Navigation/
  PROTOCOL.md (this file)
  STANDARDS.md
  .agent-context.md
  CLAUDE.md / GEMINI.md / AGENTS.md
  .agent-log/
    changelog.md
    handoffs.md
```

---

For cross-agent coordination protocol, see: `C:\GitHub\PROTOCOL.md`
