---
name: target
description: Choose which jobs to look for, by title, when the person is not after software internships. Use when the user says /target, "look for GTM engineer roles", "I'm not an intern", "change the job titles", "search for account executive jobs", "add a company board", or "go back to internships".
model: claude-sonnet-5-5
effort: low
---

# /target

Without a target the tool looks for software internships and new-grad
roles. With one it looks for the titles the person names, at the levels
they name, on the boards they name.

Show what is set first:

```
npx jev target
```

Then ask only what is missing, in one message:

1. **Titles.** The roles as postings write them, comma separated. Offer
   two or three neighbours of what they said (for "GTM Engineer": "Growth
   Engineer", "Marketing Engineer", "Revenue Operations Engineer") and
   take only the ones they say yes to.
2. **What the work is.** One sentence, so JEV can tell a real match from a
   title that only sounds like one.
3. **Levels.** Any of `internship`, `new_grad`, `mid`, `senior`. None
   means every level.
4. **Words that rule a title out**, such as `intern`, `director`, `VP`.
5. **Company boards** to poll. Greenhouse, Lever and Ashby only. Find the
   slug from a job link: `jobs.ashbyhq.com/<slug>`,
   `job-boards.greenhouse.io/<slug>`, `jobs.lever.co/<slug>`.

Save it:

```
npx jev target set --roles "GTM Engineer, Growth Engineer" --description "Builds outbound and growth systems" --levels new_grad,mid --exclude "intern, director" --board ashby:clay:Clay
```

`set` keeps whatever it is not given, and `--board` adds to the boards
already saved. `npx jev target clear` goes back to software internships.

The internship lists on GitHub are not read once a target is set. Jobs the
person already found go in `data/imports/` as a CSV with at least
`Company` and `Job Link` columns; `/discover` reads every CSV there. A
single link goes through `/apply <link>`.

End with: "Run /discover to search for these roles."

Never put a title, a fact or a level in the target that the person did not
give or approve. The profile still decides every answer on a form.
