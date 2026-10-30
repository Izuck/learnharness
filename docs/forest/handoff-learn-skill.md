# Handoff: a small LearnHarness-style teaching skill for Claude Code

Paste everything below the line into a fresh Claude Code session.

---

Build me a personal Claude Code skill that teaches any topic the way LearnHarness does, inside an ordinary Claude Code chat. There's no app and no API: it runs on my Claude plan. Use the `skill-creator` skill to build it and test it.

## Why

LearnHarness (https://github.com/amosblomqvist/learnharness) teaches me better than anything else I've used. I want a lighter version I can start anywhere with one slash command. I'm keeping three things:

1. **Finding the edge of my knowledge.** Before teaching, it binary-searches each strand the goal depends on until it knows exactly where my understanding stops.
2. **Building new ideas on ones I already hold.** It starts from facts I accept as obviously true and moves one reasoning step at a time. Each step is motivated, so the new fact feels like something I could have discovered myself.
3. **Challenging me with questions.** It asks me to predict before each step and checks after it. At the end it gives me cold problems where hints are rationed and it never tells me what I could still work out myself.

## Read first

Clone or browse the repo and read these files. Teaching quality depends on understanding them, so don't skim:

- `docs/teaching-methodology.md`: the theory (two knowledge states, the click, one reasoning step at a time, the minimal tree, a check after every step)
- `src/agent/prompts/prober/10-probe-doctrine.md`: finding the edge
- `src/agent/prompts/teacher/05-method.md`: unconditional truths first, and "how could I have discovered this?"
- `src/agent/prompts/teacher/10-planning.md`, `20-teaching.md`, `28-predictions.md`, `30-question-principles.md`
- `src/agent/prompts/shared/10-voice.md`, `16-mental-model.md`, `20-question-tools.md`, `25-confidence.md`
- `src/agent/prompts/practice/10-doctrine.md`: practice and the hint ladder (R0–R5). Use only the parts the challenge round needs.

**License:** LearnHarness is AGPL-3.0. Write the skill's instructions in your own words, based on the ideas. Don't paste its prompt text. The skill is for my personal use.

## What the skill does

Name it `edge` (invoked as `/edge <topic or goal>`), unless you find a clearly better name.

1. **Probe.** Make the goal concrete first, then work out the strands it depends on. Binary-search each strand:
   - Open near the top.
   - After a correct, confident answer, jump the difficulty up sharply.
   - After a correct but hesitant answer, step up gently.
   - After a wrong answer, narrow back down.
   - Dig into the extent of any misconception.
   - Ask one question per turn, and make every question move an edge.
   - Finish with an assessment: for each strand, its floor, ceiling, misconceptions and where to build from.
2. **Plan.** Build the minimal tree from what I hold to the goal:
   - Unconditional truths go at the bottom and my goal goes at the top.
   - Draw it as a mermaid `graph TD` and present it with a few sentences on the approach.
   - End the turn and wait for me to confirm it.
   - Redraw the plan whenever my answers show it was wrong about me.
3. **Teach.** One reasoning step at a time, in the cycle predict → teach → check:
   - Before each step, a prediction nudges me toward the next idea.
   - The teaching opens by resolving my prediction.
   - The step ends with an applied check I can answer by reasoning from the session. Each wrong option should be what someone with a specific wrong model would pick.
   - If I miss a check, repair it before building anything on top.
   - Choose Socratic or expository per step. Pick Socratic whenever I can plausibly reason my way there.
4. **Challenge.** When the plan is done, or when I ask, run a short round of cold problems on what was taught:
   - Mix the topics and never name the target.
   - Hints go up one rung of the ladder per request.
   - Grade strictly. Retest misses in a new form before ending.
5. **Voice.** No praise and no softening. Name wrong answers plainly. Say less rather than more.

## Claude Code mechanics

- **Multiple-choice questions** use `AskUserQuestion`. Put the quiz and a confidence question ("How sure? 25% / 50% / 75% / 95%") in the same call, since it takes up to 4 questions.
  - My think-out-loud goes in the selection's notes. Read it every time: it carries more signal than the answer.
  - Every option must be a bare claim with the same shape and length. The correct one must not be first, longest or the only one with reasoning.
  - Use the confidence rules from `25-confidence.md`. Wrong and confident means a committed misconception.
- **Free-recall questions** are plain chat. Grade them strictly against an answer you committed to before asking.
- **Ask one question per turn** and wait.
- **Keep state** in `<current directory>/.edge/<topic-slug>/` so a later session can resume: `assessment.md`, `plan.md` (the mermaid map plus where we are), and `log.md` (what landed, misses, misconceptions, challenge results).
  - When `/edge` runs on a topic that already has a folder, read it and offer to resume.
  - Never write outside `.edge/`.
- **Keep SKILL.md lean**, under about 300 lines. Put the detailed doctrine (probing, the method, question craft, the hint ladder) in `references/` files that the skill reads when it reaches each phase.
- Install it at `~/.claude/skills/edge/`.

## Done means

- `/edge` triggers in Claude Code and runs probe → plan (confirmed) → several taught steps with predict and check → a challenge round.
- You've tested it against a real topic with me playing the learner. A good one is "why an n-point Gauss rule is exact up to degree 2n−1 and what that means for integrating an exponential".
- You've revised it until the probe actually locates my edge and the checks can't be passed by spotting the longest option.
- State resumes correctly in a second session.
