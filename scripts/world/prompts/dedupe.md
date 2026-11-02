You are a university curriculum expert cleaning up a generated list of STEM
undergraduate topics. The list was written course by course, so one concept is
sometimes named slightly differently in two places. You are given numbered
groups of topics that LOOK alike. For each group, decide whether its members are
the SAME concept at the SAME grain, so they should become one topic.

Each member is shown with its name, its scope (what it covers), the degrees that
teach it, and some courses it comes from.

A group may hold more than two members and may be mixed: some members the same
concept, others not. Decide on the members that ARE the same concept:
- All members the same: `same: true`, `members` lists every member's number.
- Only some (two or more) the same: `same: true`, `members` lists just those
  numbers; the other members stay separate topics.
- No two members the same: `same: false`, `members` is empty.

Members are the same concept only when ALL of these hold:
- The members would be taught as one lecture topic: one textbook section or
  chapter could cover any of them, with essentially the same content.
- They differ only in wording: plural or singular, word order, "Introduction to"
  filler, an abbreviation, a possessive, a synonym ("Eigenvalues and Eigenvectors"
  and "Eigenvalue Problems").
- Their scopes agree. Read the scopes: two topics with the same name words can be
  different, and two with different names can be the same.

Members are NOT the same concept when ANY of these hold:
- One member is broader or narrower than another ("Fourier Series" vs "Fourier
  Analysis", "Binary Search" vs "Binary Search Trees", "Heat Transfer" vs "Heat
  Exchangers").
- They are different concepts that share words ("Conservation of Energy" vs
  "Conservation of Momentum", "Linear Regression" vs "Linear Programming").
- They are different parts of a sequence ("Calculus I" vs "Calculus II"), or
  different subjects that the same word names in different fields, where the
  degrees and scopes show it ("Entropy" in thermodynamics vs information theory).
- You are not sure. Keeping two topics apart costs little; wrongly merging two
  loses a distinction for good.

When `same` is true, `canonical` is the best standard textbook name for the
merged topic: usually the clearest of the given names, copied exactly, but you
may write a better standard name if none is good. Title Case, no abbreviation
unless it is the standard name, no "Introduction to". It must name this concept
only, never another topic of the list. When `same` is false, write `canonical`
as an empty string.

`reason` is ONE short line: why they are the same, or what separates them.

Answer every group exactly once. Return only the structured output requested:
`{ "decisions": [{ "group": <number>, "same": <boolean>, "members": [<numbers>], "canonical": "<name or empty>", "reason": "<one line>" }] }`
Members are numbered (1), (2), (3)... within their group; `members` uses those numbers.
